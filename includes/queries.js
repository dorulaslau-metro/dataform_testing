const projectFor = (internalCode) => `metro-bi-dl-${internalCode.toLowerCase()}-prod`;

const date_filter_var = `DATE_SUB(CURRENT_DATE('Europe/Bucharest'),INTERVAL 12 MONTH)`;

const bbd_operational0_XX = (c) => `

WITH
  bbd_merchandise_rules_bul AS (
    SELECT * FROM metro-bi-wb-inventory-s00.Country_dashboards.bbd_merchandise_rules_all_countries
    WHERE countryCode = '${c.iso2}'
  ),

  bbd_list AS (
    SELECT
      bl.* EXCEPT (changeDate), STRING(TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bl.changeDate), tz.timezone))) AS changeDate,
      LAST_VALUE(bl.logicallyDeleted) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, logicallyDeleted ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastLogicallyDeleted,
      LAST_VALUE(bl.changeDate) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, logicallyDeleted ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeDate,
      LAST_VALUE(bl.changeUser) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, logicallyDeleted ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeUser,
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bl
    INNER JOIN metro-bi-wb-inventory-s00.customization.bbd_country_timezones tz ON tz.countryCode = '${c.iso2}'
    WHERE DATE(bestBeforeDate) <= (CURRENT_DATE('Europe/Bucharest') - 3)
    AND DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
  ),

  bbd_list_deleted AS (
    SELECT * FROM bbd_list WHERE lastLogicallyDeleted = true
    AND DATE(bestBeforeDate) <= (CURRENT_DATE('Europe/Bucharest') - 3)
  ),

  bbd_checked AS (
    SELECT bc.* EXCEPT (changeDate), STRING(TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bc.changeDate), tz.timezone))) AS changeDate
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\` bc
    INNER JOIN metro-bi-wb-inventory-s00.customization.bbd_country_timezones tz ON tz.countryCode = '${c.iso2}'
    WHERE DATE(bc.PARTITIONTIME) >= DATE('2024-01-01') -- year change
  ),

  bl_not_in_bc AS (
    SELECT bl.*
    FROM bbd_list_deleted bl
    LEFT JOIN bbd_checked bc ON
      bl.storeNumber = bc.storeNumber
      -- AND bl.id = bc.bbdCheckId
      AND bl.subsystemArticleNumber = bc.subsystemArticleNumber
      AND bl.bestBeforeDate = bc.bestBeforeDate
    WHERE
      bc.storeNumber IS NULL
      AND bc.subsystemArticleNumber IS NULL
  ),

  bbd_missing AS (
    SELECT *
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_missing\`
    WHERE DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
  ),

  bl_not_in_bc_not_in_bm AS (
    SELECT bl.*
    FROM bl_not_in_bc bl
    LEFT JOIN bbd_missing bm ON
      bl.storeNumber = bm.storeNumber
      AND bl.subsystemArticleNumber = bm.subsystemArticleNumber
      AND TIMESTAMP_DIFF(TIMESTAMP(bm.changeDate), TIMESTAMP(bl.changeDate), second) IN (0, 1)
      AND bm.hasBbd = 'NO'
    WHERE
        bm.storeNumber IS NULL
        AND bm.subsystemArticleNumber IS NULL
  ),

  to_exclude AS (
    SELECT DISTINCT storeNumber, id
    FROM bl_not_in_bc_not_in_bm
  ),

  bbd_list_without_excluded AS (
    SELECT b.* FROM bbd_list b
    LEFT JOIN to_exclude e ON
      b.storeNumber = e.storeNumber
      AND b.id = e.id
    WHERE
      e.storeNumber IS NULL
      AND e.id IS NULL
  ),

  bc_distinct_ids AS (
    SELECT DISTINCT storeNumber, bbdCheckId FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\`
    WHERE DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
  ),

  bbd_list_in_bbd_checked_in_bbd_missing AS (
    SELECT
      *,
      MAX(is_in_bbd_checked) OVER (PARTITION BY id) AS is_in_bbd_checked2,
      MAX(is_in_bbd_missing) OVER (PARTITION BY id) AS is_in_bbd_missing2
    FROM (
      SELECT
        bl.*,
        CASE WHEN bc.bbdCheckId IS NULL THEN 0 ELSE 1 END AS is_in_bbd_checked,
        CASE WHEN bm.storeNumber IS NULL THEN 0 ELSE 1 END AS is_in_bbd_missing
      FROM bbd_list_without_excluded bl
      LEFT JOIN bc_distinct_ids bc ON
        bl.storeNumber = bc.storeNumber
        AND bl.id = bc.bbdCheckId
      LEFT JOIN bbd_missing bm ON
        bl.storeNumber = bm.storeNumber
        AND bl.subsystemArticleNumber = bm.subsystemArticleNumber
        AND TIMESTAMP_DIFF(TIMESTAMP(bm.changeDate), TIMESTAMP(bl.changeDate), second) IN (0, 1)
        AND bm.hasBbd = 'NO'
      )
  ),

  to_exclude_is_only_in_missing AS (
    SELECT DISTINCT storeNumber, id FROM bbd_list_in_bbd_checked_in_bbd_missing
    where is_in_bbd_missing2 = 1 AND is_in_bbd_checked2 = 0
  ),

  bbd_list_final AS (
    SELECT * FROM (
    SELECT bl.* EXCEPT (lastLogicallyDeleted, changeDate, lastChangeDate, lastChangeUser),
    changeDate, lastLogicallyDeleted, lastChangeDate, lastChangeUser,
    CASE
      WHEN lastChangeUser = 'BBDStockZero' AND lastLogicallyDeleted = true THEN lastChangeDate
      ELSE NULL
    END AS lastChangeDateWhenBBDStockZeroANDdeleted,
    FROM bbd_list_without_excluded bl
    LEFT JOIN to_exclude_is_only_in_missing ON
      bl.storeNumber = to_exclude_is_only_in_missing.storeNumber
      AND bl.id = to_exclude_is_only_in_missing.id
    WHERE to_exclude_is_only_in_missing.storeNumber IS NULL AND to_exclude_is_only_in_missing.id IS NULL
    UNION ALL
    SELECT
      *,
      CASE
        WHEN lastChangeUser = 'BBDStockZero' AND lastLogicallyDeleted = true THEN lastChangeDate
        ELSE NULL
      END AS lastChangeDateWhenBBDStockZeroANDdeleted
    FROM (
      SELECT bl.* EXCEPT (changeDate), STRING(TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bl.changeDate), tz.timezone))) AS changeDate,
      -- NULL AS lastLogicallyDeleted, NULL AS lastChangeDate, NULL AS lastChangeUser,
      -- NULL AS lastChangeDateWhenBBDStockZeroANDdeleted
      LAST_VALUE(bl.logicallyDeleted) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, logicallyDeleted ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastLogicallyDeleted,
      LAST_VALUE(bl.changeDate) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, logicallyDeleted ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeDate,
      LAST_VALUE(bl.changeUser) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, logicallyDeleted ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeUser,
      FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bl
      INNER JOIN metro-bi-wb-inventory-s00.customization.bbd_country_timezones tz ON tz.countryCode = '${c.iso2}'
      WHERE
        DATE(bl.PARTITIONTIME) >= DATE('2024-01-01') -- year change
        AND DATE(bestBeforeDate) > (CURRENT_DATE('Europe/Bucharest') - 3)
    )
    )
    WHERE
      (bbdSource IS NULL OR bbdSource != 'MARKDOWN')
      AND (changeUser IS NULL OR changeUser != 'BBD_RULE_REFRESH')
      AND ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
      AND SUBSTR(creationDate, 1, 10) <= CAST(CURRENT_DATE('Europe/Bucharest')-1 AS STRING)
  ),

  ranked_bbd_list_bul AS (
    SELECT
      countryCode, salesLine, storeNumber,
      bbdRuleId,
      articleNumber, bundleNumber, variantNumber, subsystemArticleNumber, lotNumber,
      bestBeforeDate, changeDate, changeUser, creationDate, creationUser,
      logicallyDeleted, bbdSource, quantity, lastChangeDateWhenBBDStockZeroANDdeleted,
      ROW_NUMBER() OVER (PARTITION BY storeNumber, id
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS rn,
      lastLogicallyDeleted,
      LAST_VALUE(changeDate) OVER (PARTITION BY salesLine, storeNumber, id
        ORDER BY changeDate ASC, dana_ingestion_timestamp ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeDate,
      id
    FROM bbd_list_final
    WHERE
      ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
      AND SUBSTR(creationDate, 1, 10) <= CAST(CURRENT_DATE('Europe/Bucharest')-1 AS STRING)
  ),

  bbd_list_bul AS (
    SELECT
      * EXCEPT (rn)
    FROM ranked_bbd_list_bul
    WHERE
      rn = 1
  ),

    bc AS (
    SELECT bc.* EXCEPT (changeDate),
    LEAD(status) OVER (PARTITION BY storeNumber, bbdCheckId
        ORDER BY TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bc.changeDate), tz.timezone)) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS nextStatusBC,
    STRING(TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bc.changeDate), tz.timezone))) AS changeDate,
    bc.changeDate AS changeDateBCUTC
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\` bc
    INNER JOIN metro-bi-wb-inventory-s00.customization.bbd_country_timezones tz ON tz.countryCode = '${c.iso2}'
    WHERE
      DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
      -- AND DATE(creationDate) >= DATE('2024-01-01')
      AND DATE(creationDate) <= (CURRENT_DATE('Europe/Bucharest')-1)
  ),

  bbd_checked_open_done_bul AS (
    SELECT * EXCEPT (rn) FROM (
      SELECT
        ROW_NUMBER() OVER (PARTITION BY storeNumber, bbdCheckId, status ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS rn,
        * FROM bc
    )
    WHERE rn = 1
  ),

  bbd_checked_bul AS (
    SELECT * EXCEPT (type) FROM (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY storeNumber, bbdCheckId, DATE(TIMESTAMP(changeDate)), type ORDER BY TIMESTAMP(changeDate) DESC, TIMESTAMP(dana_ingestion_timestamp) DESC) AS rn
    FROM (
    SELECT *,
      CASE
        WHEN status='OPEN' OR (status='DONE' AND quantity=0) THEN 'checked'
        WHEN status='DONE' AND quantity > 0 THEN 'actioned' -- aici de schimbat?
      END AS type
    FROM (
    SELECT
      *,
      CASE
        WHEN creationUser LIKE '%BBD%' THEN creationUser
        ELSE 'User'
      END AS creationUser2
    FROM bbd_checked_open_done_bul
    )))
    WHERE rn=1
  ),

  bbd_checked_aux_bul AS (
    SELECT
      *,
      LAG(status) OVER (PARTITION BY storeNumber, bbdCheckId
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS previousStatus,
      LEAD(status) OVER (PARTITION BY storeNumber, bbdCheckId
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS nextStatus,
      LEAD(quantity) OVER (PARTITION BY storeNumber, bbdCheckId
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS nextQuantity,
    FROM bbd_checked_bul
  ),

  bl_joined_bmr_bul AS (
    SELECT
      bl.countryCode, bl.salesLine, bl.storeNumber,
      bl.bbdRuleId, bl.id, bl.quantity,
      bl.articleNumber, bl.bundleNumber, bl.variantNumber, bl.subsystemArticleNumber, bl.lotNumber,
      bl.bestBeforeDate, bl.changeDate, bl.changeUser, bl.creationDate, bl.creationUser, bl.bbdSource,
      bl.logicallyDeleted,
      bl.lastLogicallyDeleted, bl.lastChangeDate,
      bl.lastChangeDateWhenBBDStockZeroANDdeleted,
      bmr.departmentNumber, bmr.mainMerchandiseGroup, bmr.merchandiseGroup, bmr.merchandiseSubgroup,
      bmr.gracePeriod, EXTRACT(DATE FROM PARSE_DATETIME('%Y-%m-%d', bl.bestBeforeDate)) - bmr.gracePeriod AS dateEnteringGracePeriod,
      MIN(GREATEST(DATE(bl.changeDate), EXTRACT(DATE FROM PARSE_DATETIME('%Y-%m-%d', bl.bestBeforeDate)) - bmr.gracePeriod))
        OVER (PARTITION BY bl.storeNumber, bl.id) AS dateWhenFirstlyNeededToBeRemoved -- grace period might
          -- have been already started, but it doesn't matter - because the article might not yet be found in bbd_list
    FROM bbd_list_bul bl
    INNER JOIN bbd_merchandise_rules_bul bmr ON
      bmr.countryCode = bl.countryCode 
      AND bmr.ruleId = bl.bbdRuleId AND (bmr.storeNumber IS NULL OR bl.storeNumber = bmr.storeNumber)
      AND bmr.activeFrom <= TIMESTAMP(bl.creationDate) AND TIMESTAMP(bl.creationDate) <= bmr.activeTo
      AND bmr.active = true
  ),

  bl_joined_bmr_joined_bc_bul AS (
    SELECT
      bl_bmr.countryCode, bl_bmr.salesLine, bl_bmr.storeNumber,
      bl_bmr.bbdRuleId,
      CASE WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN NULL
        ELSE bc.bbdCheckId END AS bbdCheckId,
      bl_bmr.id,
      CASE WHEN bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN NULL ELSE bc.quantity END AS quantity,
      CASE WHEN bl_bmr.quantity = 0 THEN NULL ELSE bl_bmr.quantity END AS quantity_to_be_checked,
      bc.quantity AS quantity_checked,
      CASE WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId THEN true ELSE false END AS bc_not_null_and_different,
      CASE WHEN bl_bmr.id != bc.bbdCheckId THEN true ELSE false END AS bc_different,
      bl_bmr.articleNumber, bl_bmr.bundleNumber, bl_bmr.variantNumber, bl_bmr.subsystemArticleNumber, bl_bmr.lotNumber,
      bl_bmr.bestBeforeDate, bl_bmr.gracePeriod, bl_bmr.bbdSource, bl_bmr.dateEnteringGracePeriod, bl_bmr.dateWhenFirstlyNeededToBeRemoved,
      CASE
        WHEN bc.bbdCheckId IS NULL
          OR (bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod) THEN false
          ELSE true END AS isChecked,
      CASE
        WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN false
        WHEN bc.status = 'DONE' AND bc.quantity = 0 AND (bc.creationUser IS NULL OR (bc.creationUser NOT IN ('BBDExpired', 'BBDStockZero'))) THEN true
        WHEN bc.status = 'DONE' AND bc.quantity = 0 AND bc.creationUser = 'BBDExpired' THEN false
        WHEN bc.status = 'DONE' AND bc.quantity = 0 AND bc.creationUser = 'BBDStockZero' THEN false
        ELSE false
      END AS isNotFound,
      CASE
        WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN false
        WHEN bc.status = 'OPEN' AND bc.quantity > 0 AND (bc.creationUser NOT IN ('BBDStockZero', 'BBDExpired')) THEN true
        ELSE false
      END AS isRemoved,
      CASE WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN NULL
        ELSE bc.status END AS statusBbdChecked,
      bl_bmr.changeDate AS changeDateBL,
      CASE WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN NULL
        ELSE bc.changeDate END AS changeDateBC,
      bc.changeDateBCUTC,
      bl_bmr.creationDate AS creationDateBL, bl_bmr.creationUser AS creationUserBL,
      CASE WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN NULL
        ELSE bc.creationUser END AS creationUserBC,
      bl_bmr.changeUser AS changeUserBL,
      CASE WHEN bc.bbdCheckId IS NOT NULL AND bl_bmr.id != bc.bbdCheckId AND DATE(bc.changeDate) < bl_bmr.dateEnteringGracePeriod THEN NULL
        ELSE bc.creationUser2 END AS creationUser2,
      bc.checkUser,
      bl_bmr.logicallyDeleted, bl_bmr.lastLogicallyDeleted, bl_bmr.lastChangeDate,
      bl_bmr.departmentNumber, bl_bmr.mainMerchandiseGroup, bl_bmr.merchandiseGroup, bl_bmr.merchandiseSubgroup,
      bc.previousStatus,
      bc.nextStatus,
      bl_bmr.lastChangeDateWhenBBDStockZeroANDdeleted,
    FROM bl_joined_bmr_bul bl_bmr
    LEFT JOIN bbd_checked_aux_bul bc ON

      bl_bmr.salesLine = bc.salesLine
      AND bl_bmr.storeNumber = bc.storeNumber
      AND bl_bmr.id = bc.bbdCheckId
    WHERE 1=1
      -- AND bl_bmr.lastLogicallyDeleted = true
      AND bc.bbdCheckId IS NULL
      OR (
        (bc.bbdCheckID IS NULL OR bc.status = 'OPEN' OR (bc.status = 'DONE' AND bc.quantity = 0))
        AND (NOT(bc.bbdCheckID IS NOT NULL AND bl_bmr.dateEnteringGracePeriod > DATE(bc.changeDate))) -- am modificat asta (!!!)
        AND
        (bc.bbdCheckId IS NULL OR ((status = 'OPEN'
        )
        OR ((status = 'DONE' AND bc.quantity > 0 AND COALESCE(previousStatus, '') = 'OPEN')
          OR (status = 'DONE' AND bc.quantity = 0))))
        )
      
  ),

  joined_by_id AS (
    SELECT
      statusBbdChecked,
      bbdCheckId,
      changeDateBC,
      quantity,
      quantity_checked,
      bc_not_null_and_different,
      bc_different,
      isChecked,
      isNotFound,
      isRemoved,
      creationUserBC,
      creationUser2,
      nextStatus,
      * EXCEPT (statusBbdChecked, bbdCheckId, quantity, quantity_checked, bc_not_null_and_different, bc_different, 
        isChecked, isNotFound, isRemoved, creationUserBC, creationUser2, nextStatus, changeDateBC)
    -- de completat cu coloanele finale ca sa pot face union all
    FROM bl_joined_bmr_joined_bc_bul
    WHERE
      NOT (lastLogicallyDeleted = true
           AND bbdCheckId IS NULL) -- id is not deleted (so ofc it doesn't appear in bbd_checked) or it appears in bbd_checked
  ),


  joined_by_bbd AS (
    SELECT
      CASE
        WHEN ABS(TIMESTAMP_DIFF(TIMESTAMP(changeDateBL), TIMESTAMP(changeDateBcJoinedByBbd), second)) <= 1 THEN 'checked_removed_from_shelf'
        WHEN TIMESTAMP_DIFF(TIMESTAMP(changeDateBL), TIMESTAMP(changeDateBcJoinedByBbd), second) > 1 THEN 'checked_not_found'
        WHEN changeDateBcJoinedByBbd IS NULL THEN 'bbd_removed_or_data_error'
      END AS id_not_traceable_conclusion,
      * EXCEPT (rn) FROM (
        SELECT
          bl_bmr_bc.*,
          bc.status AS statusBcJoinedByBbd,
          bc.quantity AS quantityBcJoinedByBbd,
          bc.changeDate AS changeDateBcJoinedByBbd,
          bc.bbdCheckId AS bbdCheckIdBcJoinedByBbd,
          bc.creationUser AS creationUserBcJoinedByBbd,
          bc.nextStatusBC AS nextStatusBcJoinedByBbd,
          -- bl_bmr_bc.previousStatus AS previousStatus_bl_bmr_bc,
          ROW_NUMBER() OVER (PARTITION BY bl_bmr_bc.storeNumber, bl_bmr_bc.id ORDER BY bc.changeDate DESC, bc.status ASC) AS rn
            -- very important that it's ordered by status also, otherwise we get random results when changeDate is identical within the same
            -- partition, like obtaining bbds actioned when in reality there were no actions
        FROM bl_joined_bmr_joined_bc_bul bl_bmr_bc
        LEFT JOIN bc ON
          bl_bmr_bc.storeNumber = bc.storeNumber
          AND bl_bmr_bc.subsystemArticleNumber = bc.subsystemArticleNumber
          AND bl_bmr_bc.bestBeforeDate = bc.bestBeforeDate
          AND (bl_bmr_bc.changeDateBL > bc.changeDate 
            OR ABS(TIMESTAMP_DIFF(TIMESTAMP(bl_bmr_bc.changeDateBL), TIMESTAMP(bc.changeDate), second)) <= 1)
        WHERE
          bl_bmr_bc.lastLogicallyDeleted = true
          AND bl_bmr_bc.bbdCheckId IS NULL -- daca in bbd_list am un id cu logically_deleted = true si 
        --   -- nu gasesc corespondent pe id-bbdCheckId in bbd_checked
    )
    WHERE rn = 1 AND statusBcJoinedByBbd = 'OPEN' -- nu ma uit la cele care nu au avut match pe id si care au match pe 
    -- bbd dar la care ultimul status e DONE
    -- dar what about cele care nu au match nici pe id nici pe bbd? pai sa nu uitam ca au lastlogicallydeleted = true, deci
    -- inseamna ca bbd-ul a fost sters sau e o eroare in date; regardless, nu le iau in seama
  ),

  joined_by_bbd_checked_cases AS (
    SELECT
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN statusBcJoinedByBbd
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN 'DONE'
      END AS statusBbdChecked,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN bbdCheckIdBcJoinedByBbd
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN NULL
      END AS bbdCheckId,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN changeDateBcJoinedByBbd
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN changeDateBL
      END AS changeDateBC,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN quantityBcJoinedByBbd
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN 0
      END AS quantity,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN quantityBcJoinedByBbd
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN 0
      END AS quantity_checked,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN true
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN FALSE
      END AS bc_not_null_and_different,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN true
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN FALSE
      END AS bc_different,
      true AS isChecked,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN false
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN true
      END AS isNotFound,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN true
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN false
      END AS isRemoved,
      -- creationUserBcJoinedByBbd AS creationUserBC,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN creationUserBcJoinedByBbd
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN changeUserBL
      END AS creationUserBC,
      CASE
        WHEN creationUSerBcJoinedByBbd LIKE '%BBD%' THEN creationUSerBcJoinedByBbd
        ELSE 'User'
      END AS creationUser2,
      CASE
        WHEN id_not_traceable_conclusion = 'checked_removed_from_shelf' THEN nextStatusBcJoinedByBbd
        WHEN id_not_traceable_conclusion = 'checked_not_found' THEN NULL
      END AS nextStatus,
      -- nextStatusBcJoinedByBbd AS nextStatus,
      * EXCEPT (statusBbdChecked, quantity, quantity_checked, bc_not_null_and_different, 
        bc_different, isChecked, isNotFound, isRemoved, creationUserBC, creationUser2, nextStatus, bbdCheckId, 
        statusBcJoinedByBbd, quantityBcJoinedByBbd, changeDateBcJoinedByBbd, bbdCheckIdBcJoinedByBbd, 
        creationUserBcJoinedByBbd, nextStatusBcJoinedByBbd, id_not_traceable_conclusion, changeDateBC)
    FROM joined_by_bbd
  ),

  bl_joined_bmr_joined_bc_bul_intermed AS (
    SELECT * FROM joined_by_id UNION ALL
    SELECT * FROM joined_by_bbd_checked_cases
  ),

  -- bl_joined_bmr_joined_bc_bul_intermed AS (
  --   SELECT
  --     countryCode, salesLine, storeNumber, bbdRuleId,
  --     id AS bbdCheckId, id, 0 AS quantity,
  --     0 AS quantity_to_be_checked,
  --     0 AS quantity_checked,
  --     bc_not_null_and_different, bc_different, 
  --     articleNumber, bundleNumber, variantNumber, subsystemArticleNumber, lotNumber, bestBeforeDate, gracePeriod, bbdSource,
  --     dateEnteringGracePeriod, dateWhenFirstlyNeededToBeRemoved, true AS isChecked, true AS isNotFound, false AS isRemoved,
  --     'DONE' AS statusBbdChecked, changeDateBL, lastChangeDate AS changeDateBC,
  --     creationDateBL, creationUserBL, creationUserBL AS creationUserBC, changeUserBL, creationUserBL AS creationUser2,
  --     checkUser,  logicallyDeleted, lastLogicallyDeleted, lastChangeDate, departmentNumber, mainMerchandiseGroup,
  --     merchandiseGroup, merchandiseSubgroup, previousStatus, nextStatus, lastChangeDateWhenBBDStockZeroANDdeleted
  --   FROM bl_joined_bmr_joined_bc_bul
  --   WHERE bbdCheckId IS NULL AND lastLogicallyDeleted = true   ------- pe aici ar trebui sa schimb pentru situatiile in care 
  --   -- user-ul da remove from shelf, dar mai exista articolul cu acelasi bbd si in actions, si ce se intampla in bbd_checked
  --   -- e ca doar se updateaza cantitatea. desi eu imi amintesc ca am facut asta..sa ma mai uit. notita pt luni 24.02.2025
  --   UNION ALL
  --   SELECT * FROM bl_joined_bmr_joined_bc_bul
  --   WHERE NOT (bbdCheckId IS NULL AND lastLogicallyDeleted = true)
  -- ),

  bl_joined_bmr_joined_bc2_bul AS (
    SELECT * FROM bl_joined_bmr_joined_bc_bul_intermed
    -- WHERE
    --   bbdCheckID IS NULL OR id = bbdCheckId
    -- UNION ALL
    -- SELECT * FROM bl_joined_bmr_joined_bc_bul_intermed
    -- WHERE
    --   bbdCheckId IS NULL OR (id != bbdCheckId AND dateEnteringGracePeriod <= DATE(changeDateBC))
  ),

  bbd_first_occurence_in_checked AS (
    SELECT
      * EXCEPT (referenceTimestamp),
      DATE(referenceTimestamp) AS dateFirstOccurenceBbdChecked,
      DATE(referenceTimestamp) AS dateWhenAddedToCart,
      referenceTimestamp AS timestampWhenAddedToCart,
      DATE(referenceTimestamp) AS dateWhenNotFound,
      referenceTimestamp AS timestampWhenNotFound
    FROM (
      SELECT
        *,
        MIN(TIMESTAMP(changeDateBC)) OVER (PARTITION BY storeNumber, id, statusBbdChecked) AS referenceTimestamp
      FROM bl_joined_bmr_joined_bc2_bul
    )
  ),

  bbd_first_occurence_in_checked_aux AS (
    SELECT
      *
      EXCEPT (
        dateWhenAddedToCart, timestampWhenAddedToCart,
      dateWhenNotFound, timestampWhenNotFound, creationUserBL, creationUserBC),
      creationUserBC,
      CASE
        WHEN creationUserBL LIKE '%BBD%' OR creationUserBL LIKE '%MMS%' THEN creationUserBL
        ELSE 'User'
      END AS creationUserBL,
      CASE
        WHEN isRemoved = true THEN dateWhenAddedToCart
        ELSE NULL
      END AS dateWhenAddedToCart,
      CASE
        WHEN isRemoved = true THEN timestampWhenAddedToCart
        ELSE NULL
      END AS timestampWhenAddedToCart,
    CASE
        WHEN isNotFound = true THEN dateWhenNotFound
        ELSE NULL
      END AS dateWhenNotFound,
      CASE
        WHEN isNotFound = true THEN timestampWhenNotFound
        ELSE NULL
      END AS timestampWhenNotFound,
    FROM bbd_first_occurence_in_checked
  )

SELECT * FROM bbd_first_occurence_in_checked_aux
`;

const bbd_operational1_XX = (c) => `


WITH
  bbd_first_occurence_in_checked_aux AS (
    SELECT * FROM metro-bi-wb-inventory-s00.Country_dashboards.bbd_operational0_${c.iso2}
    -- where id = 'f587c62f-42cb-482a-832d-2357bdb54841' AND storeNumber = 3
  ),

  bbd_merchandise_rules_bul AS (
    SELECT * FROM metro-bi-wb-inventory-s00.Country_dashboards.bbd_merchandise_rules_all_countries
    WHERE countryCode = '${c.iso2}'
  ),

  lld3 AS (
    SELECT DISTINCT storeNumber, id FROM (
      SELECT bl.storeNumber, bl.id FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bl
      INNER JOIN bbd_merchandise_rules_bul bmr ON
        bmr.countryCode = bl.countryCode 
        AND bmr.ruleId = bl.bbdRuleId AND (bmr.storeNumber IS NULL OR bl.storeNumber = bmr.storeNumber)
        AND bmr.activeFrom <= TIMESTAMP(bl.creationDate) AND TIMESTAMP(bl.creationDate) <= bmr.activeTo
        AND bmr.active = true
      WHERE
        DATE(bl.PARTITIONTIME) >= DATE('2024-01-01') -- year change
        AND DATE_SUB(DATE(bl.bestBeforeDate), INTERVAL (bmr.gracePeriod) DAY) > DATE(bl.changeDate)
        AND bl.logicallyDeleted = true
        AND ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
    )
  ),

  bbd_list AS (
    SELECT
      bl.* EXCEPT (changeDate), STRING(TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bl.changeDate), tz.timezone))) AS changeDate,
      LAST_VALUE(bl.logicallyDeleted) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC, logicallyDeleted ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastLogicallyDeleted,
      LAST_VALUE(bl.changeDate) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC, logicallyDeleted ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeDate,
      LAST_VALUE(bl.changeUser) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC, logicallyDeleted ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeUser,
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bl
    INNER JOIN metro-bi-wb-inventory-s00.customization.bbd_country_timezones tz ON tz.countryCode = '${c.iso2}'
    WHERE DATE(bl.PARTITIONTIME) >= DATE('2024-01-01') -- year change
  ),

  bbd_list_deleted AS (
    SELECT * FROM bbd_list WHERE lastLogicallyDeleted = true
  ),

  bbd_checked AS (
    SELECT bc.* EXCEPT (changeDate), STRING(TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bc.changeDate), tz.timezone))) AS changeDate
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\` bc
    INNER JOIN metro-bi-wb-inventory-s00.customization.bbd_country_timezones tz ON tz.countryCode = '${c.iso2}'
    WHERE DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
      AND DATE(bestBeforeDate) <= (CURRENT_DATE('Europe/Bucharest') - 3)
  ),

  bl_not_in_bc AS (
    SELECT bl.*
    FROM bbd_list_deleted bl
    LEFT JOIN bbd_checked bc ON
      bl.storeNumber = bc.storeNumber
      AND bl.id = bc.bbdCheckId
    WHERE
      bc.storeNumber IS NULL
      AND bc.bbdCheckId IS NULL
  ),

  bbd_missing AS (
    SELECT *
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_missing\`
    WHERE DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
  ),

  bl_not_in_bc_not_in_bm AS (
    SELECT bl.*
    FROM bl_not_in_bc bl
    LEFT JOIN bbd_missing bm ON
      bl.storeNumber = bm.storeNumber
      AND bl.subsystemArticleNumber = bm.subsystemArticleNumber
      AND TIMESTAMP_DIFF(TIMESTAMP(bm.changeDate), TIMESTAMP(bl.changeDate), second) IN (0, 1)
      AND bm.hasBbd = 'NO'
    WHERE
        bm.storeNumber IS NULL
        AND bm.subsystemArticleNumber IS NULL
  ),

  to_exclude AS (
    SELECT DISTINCT storeNumber, id
    FROM bl_not_in_bc_not_in_bm
  ),

  bbd_list_without_excluded AS (
    SELECT b.* FROM bbd_list b
    LEFT JOIN to_exclude e ON
      b.storeNumber = e.storeNumber
      AND b.id = e.id
    WHERE
      e.storeNumber IS NULL
      AND e.id IS NULL
  ),

  bc_distinct_ids AS (
    SELECT DISTINCT storeNumber, bbdCheckId FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\`
    WHERE DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
  ),

  bbd_list_in_bbd_checked_in_bbd_missing AS (
    SELECT
      *,
      MAX(is_in_bbd_checked) OVER (PARTITION BY id) AS is_in_bbd_checked2,
      MAX(is_in_bbd_missing) OVER (PARTITION BY id) AS is_in_bbd_missing2
    FROM (
      SELECT
        bl.*,
        CASE WHEN bc.bbdCheckId IS NULL THEN 0 ELSE 1 END AS is_in_bbd_checked,
        CASE WHEN bm.storeNumber IS NULL THEN 0 ELSE 1 END AS is_in_bbd_missing
      FROM bbd_list_without_excluded bl
      LEFT JOIN bc_distinct_ids bc ON
        bl.storeNumber = bc.storeNumber
        AND bl.id = bc.bbdCheckId
      LEFT JOIN bbd_missing bm ON
        bl.storeNumber = bm.storeNumber
        AND bl.subsystemArticleNumber = bm.subsystemArticleNumber
        AND TIMESTAMP_DIFF(TIMESTAMP(bm.changeDate), TIMESTAMP(bl.changeDate), second) IN (0, 1)
        AND bm.hasBbd = 'NO'
      )
  ),

  to_exclude_is_only_in_missing AS (
    SELECT DISTINCT storeNumber, id FROM bbd_list_in_bbd_checked_in_bbd_missing
    where is_in_bbd_missing2 = 1 AND is_in_bbd_checked2 = 0
  ),

  bbd_list_final AS (
    SELECT * FROM (
    SELECT bl.* EXCEPT (lastLogicallyDeleted, changeDate, lastChangeDate, lastChangeUser),
    changeDate, lastLogicallyDeleted, lastChangeDate, lastChangeUser,
    CASE
      WHEN lastChangeUser = 'BBDStockZero' AND lastLogicallyDeleted = true THEN lastChangeDate
      ELSE NULL
    END AS lastChangeDateWhenBBDStockZeroANDdeleted,
    FROM bbd_list_without_excluded bl
    LEFT JOIN to_exclude_is_only_in_missing ON
      bl.storeNumber = to_exclude_is_only_in_missing.storeNumber
      AND bl.id = to_exclude_is_only_in_missing.id
    WHERE to_exclude_is_only_in_missing.storeNumber IS NULL AND to_exclude_is_only_in_missing.id IS NULL
    UNION ALL
    SELECT
      *,
      CASE
        WHEN lastChangeUser = 'BBDStockZero' AND lastLogicallyDeleted = true THEN lastChangeDate
        ELSE NULL
      END AS lastChangeDateWhenBBDStockZeroANDdeleted
    FROM (
      SELECT bl.* EXCEPT (changeDate), STRING(TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(bl.changeDate), tz.timezone))) AS changeDate,
      -- NULL AS lastLogicallyDeleted, NULL AS lastChangeDate, NULL AS lastChangeUser,
      -- NULL AS lastChangeDateWhenBBDStockZeroANDdeleted
      LAST_VALUE(bl.logicallyDeleted) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC, logicallyDeleted ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastLogicallyDeleted,
      LAST_VALUE(bl.changeDate) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC, logicallyDeleted ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeDate,
      LAST_VALUE(bl.changeUser) OVER (PARTITION BY bl.storeNumber, bl.id
        ORDER BY bl.changeDate ASC, TIMESTAMP(bl.dana_ingestion_timestamp) ASC, logicallyDeleted ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lastChangeUser,
      FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bl
      INNER JOIN metro-bi-wb-inventory-s00.customization.bbd_country_timezones tz ON tz.countryCode = '${c.iso2}'
      WHERE DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
        AND DATE(bestBeforeDate) > (CURRENT_DATE('Europe/Bucharest') - 3)
        AND ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
    )
    )
    WHERE
      (bbdSource IS NULL OR bbdSource != 'MARKDOWN')
      AND (changeUser IS NULL OR changeUser != 'BBD_RULE_REFRESH')
      AND ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
      AND SUBSTR(creationDate, 1, 10) <= CAST(CURRENT_DATE('Europe/Bucharest')-1 AS STRING)
  ),

  ranked_bbd_list_bul AS (
    SELECT
      countryCode, salesLine, storeNumber,
      bbdRuleId,
      articleNumber, bundleNumber, variantNumber, subsystemArticleNumber, lotNumber,
      bestBeforeDate, changeDate, creationDate, changeUser, creationUser,
      logicallyDeleted, bbdSource, quantity, lastChangeDateWhenBBDStockZeroANDdeleted,
      ROW_NUMBER() OVER (PARTITION BY storeNumber, id
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS rn,
      lastLogicallyDeleted, lastChangeDate, 
      id
    FROM bbd_list_final
    WHERE
      ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
      AND SUBSTR(creationDate, 1, 10) <= CAST(CURRENT_DATE('Europe/Bucharest')-1 AS STRING)
  ),

  bbd_checked_open_done_bul AS (
    SELECT * EXCEPT (rn) FROM (
      SELECT
        ROW_NUMBER() OVER (
          PARTITION BY storeNumber, bbdCheckId, status ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC
        ) AS rn,
        * FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\`
      WHERE
        DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
        AND DATE(PARTITIONTIME) <= (CURRENT_DATE('Europe/Bucharest')-1)
    )
    WHERE rn = 1
  ),

  bbd_checked_bul AS (
    SELECT * EXCEPT (type) FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY storeNumber, bbdCheckId, DATE(TIMESTAMP(changeDate)), type
          ORDER BY TIMESTAMP(changeDate) DESC, TIMESTAMP(dana_ingestion_timestamp) DESC
        ) AS rn
      FROM (
        SELECT *,
          CASE
            WHEN status='OPEN' OR (status='DONE' AND quantity=0) THEN 'checked'
            WHEN status='DONE' AND quantity > 0 THEN 'actioned' -- aici de schimbat?
          END AS type
        FROM (
          SELECT
            *,
            CASE
              WHEN creationUser LIKE '%BBD%' THEN creationUser
              ELSE 'User'
            END AS creationUser2
          FROM bbd_checked_open_done_bul
        )
      )
    )
    WHERE rn = 1
  ),

  bbd_checked_aux_bul AS (
    SELECT
      *,
      LAG(status) OVER (PARTITION BY storeNumber, bbdCheckId
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS previousStatus,
      LEAD(status) OVER (PARTITION BY storeNumber, bbdCheckId
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS nextStatus,
      LEAD(quantity) OVER (PARTITION BY storeNumber, bbdCheckId
        ORDER BY TIMESTAMP(changeDate) ASC, TIMESTAMP(dana_ingestion_timestamp) ASC) AS nextQuantity,
    FROM bbd_checked_bul
  ),

  bl_joined_bmr_joined_bc_joined_bc_bul AS (
      SELECT
        * EXCEPT (statusBbdChecked, changeDateBC, checkUser),
        statusBbdChecked, changeDateBC,
        checkUser
      FROM bbd_first_occurence_in_checked_aux
      UNION ALL
      SELECT
        bl_bmr_bc.* EXCEPT (statusBbdChecked, changeDateBC, checkUser),
        bc.status AS statusBbdChecked, bc.changeDate AS changeDateBC,
        bc.checkUser
      FROM bbd_first_occurence_in_checked_aux bl_bmr_bc
      INNER JOIN bbd_checked_aux_bul bc ON
        bl_bmr_bc.salesLine = bc.salesLine
        AND bl_bmr_bc.storeNumber = bc.storeNumber
        AND bl_bmr_bc.timestampWhenAddedToCart <= TIMESTAMP(bc.changeDate)

        AND bl_bmr_bc.bbdCheckId = bc.bbdCheckId --(!!!)
      WHERE
        bl_bmr_bc.statusBbdChecked = 'OPEN' AND bc.status = 'DONE' AND bc.quantity > 0
        AND
        ((bc.status = 'OPEN' AND NOT (bc.nextStatus = 'DONE' AND bc.nextQuantity = 0))
        OR ((bc.status = 'DONE' AND bc.quantity > 0 AND bc.previousStatus = 'OPEN')
        OR (bc.status = 'DONE' AND bc.quantity = 0)))
  ),

  bl_joined_bmr_joined_bc_joined_bc_aux0_bul AS (
    SELECT
      MAX(statusMapped) OVER (PARTITION BY storeNumber, id) AS lastStatus,
      *
    FROM (
      SELECT
        CASE WHEN statusBbdChecked = 'OPEN' THEN 1 ELSE 2 END AS statusMapped,
        *
      FROM bl_joined_bmr_joined_bc_joined_bc_bul
    )
  ),

  bl_joined_bmr_joined_bc_joined_bc_aux_bul AS (
      SELECT
        * EXCEPT (lastStatus, dateWhenNotFound),
        CASE WHEN MAX(TIMESTAMP(changeDateBC)) OVER (PARTITION BY storeNumber, id) IS NULL THEN DATE(lastChangeDate) END AS dateWhenNotFound,
        CASE WHEN MAX(TIMESTAMP(changeDateBC)) OVER (PARTITION BY storeNumber, id) IS NOT NULL
          THEN MAX(TIMESTAMP(changeDateBC)) OVER (PARTITION BY storeNumber, id) END AS timestampWhenActioned,
      FROM bl_joined_bmr_joined_bc_joined_bc_aux0_bul
      WHERE lastStatus = 2 --'DONE'
      UNION ALL
      SELECT * EXCEPT (lastStatus, dateWhenNotFound),
      dateWhenNotFound
      ,
        NULL AS timestampWhenActioned
      FROM bl_joined_bmr_joined_bc_joined_bc_aux0_bul
      WHERE lastStatus = 1 -- = 'OPEN'
  ),

 calendar AS (
    SELECT * FROM metro-bi-wb-inventory-s00.calendar_date3.calendar_date3
    WHERE calendarDate <= (CURRENT_DATE('Europe/Bucharest')-1)
  ),

  rows_generated AS (
    SELECT
      *,
      CASE
        WHEN CAST(bestBeforeDate AS DATE) < Date THEN true
        ELSE false
      END AS isBbdDue,
      CASE
        WHEN (EXTRACT(DATE FROM PARSE_DATETIME('%Y-%m-%d', bestBeforeDate)) - gracePeriod) <= Date THEN true
        ELSE false
      END AS shouldBeChecked,
    FROM (

      SELECT
        '1' AS cv,
        * EXCEPT (statusBbdChecked, quantity, isChecked, isNotFound, isRemoved, changeDateBC, creationUserBC, creationUser2,
        dateWhenNotFound, timestampWhenNotFound, checkUser),
        quantity_to_be_checked AS quantity, DATE(TIMESTAMP(changeDateBC)) AS Date, isChecked, isNotFound, isRemoved, changeDateBC, creationUserBC, NULL AS timestampWhenActioned,
        statusBbdChecked AS status,
        creationUser2,
        dateWhenNotFound, timestampWhenNotFound, checkUser
      FROM bbd_first_occurence_in_checked_aux
      WHERE dateWhenFirstlyNeededToBeRemoved > COALESCE(dateWhenAddedToCart, dateWhenNotFound, CURRENT_DATE('Europe/Bucharest')-1)

      UNION ALL

      -- 1
      SELECT
        '2' AS cv,
        bbd.* EXCEPT (statusBbdChecked, quantity, isChecked, isNotFound, isRemoved,
        changeDateBC, creationUserBC, creationUser2,
        dateWhenNotFound, timestampWhenNotFound, checkUser),
        CASE
          WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound, DATE(bbd.changeDateBC)) THEN quantity_checked 
          ELSE quantity_to_be_checked
        END AS quantity,
        calendar.calendarDate AS Date,
        CASE WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound) THEN bbd.isChecked ELSE false END AS isChecked,
        CASE WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound) THEN bbd.isNotFound ELSE false END AS isNotFound,
        CASE WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound) THEN bbd.isRemoved ELSE false END AS isRemoved,
        CASE WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound, DATE(bbd.changeDateBC)) THEN bbd.changeDateBC ELSE NULL END AS changeDateBC,
        CASE WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound, DATE(bbd.changeDateBC)) THEN bbd.creationUserBC ELSE NULL END AS creationUserBC,
        NULL AS timestampWhenActioned,
        CASE WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound, DATE(bbd.changeDateBC)) THEN bbd.statusBbdChecked ELSE 'PENDING' END AS status,
        CASE WHEN calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound, DATE(bbd.changeDateBC)) THEN bbd.creationUserBC ELSE bbd.creationUserBL END AS creationUser2,
        dateWhenNotFound, timestampWhenNotFound, checkUser
      FROM bbd_first_occurence_in_checked_aux bbd
      INNER JOIN calendar ON
        bbd.dateWhenFirstlyNeededToBeRemoved <= calendar.calendarDate
        AND calendar.calendarDate <= COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound,
        DATE(TIMESTAMP(bbd.changeDateBC)), DATE(lastChangeDateWhenBBDStockZeroANDdeleted), CURRENT_DATE('Europe/Bucharest')-1)
      WHERE
        dateWhenFirstlyNeededToBeRemoved <= COALESCE(dateWhenAddedToCart, dateWhenNotFound,
        DATE(TIMESTAMP(bbd.changeDateBC)), DATE(lastChangeDateWhenBBDStockZeroANDdeleted), CURRENT_DATE('Europe/Bucharest')-1)
        AND (
          bbd.statusBbdChecked = 'OPEN'
          OR (bbd.statusBbdChecked = 'DONE' AND bbd.quantity = 0 AND (previousStatus != 'OPEN' OR previousStatus IS NULL))
          OR bbd.statusBbdChecked IS NULL)
        AND bbd.dateWhenFirstlyNeededToBeRemoved <= (CURRENT_DATE('Europe/Bucharest')-1)

      -- INCA UN union all pt cand status = DONE si qty 0 si previousStatus = 'OPEN'
      UNION ALL
      SELECT
        '3' AS cv,

        bbd.* EXCEPT (statusBbdChecked, quantity, isChecked, isNotFound, isRemoved, changeDateBC, creationUserBC, creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser),
        bbd.quantity,
        DATE(bbd.dateWhenNotFound) AS Date,
        true AS isChecked,
        true AS isNotFound,
        false AS isRemoved,
        bbd.changeDateBC,
        bbd.creationUserBC,
        NULL AS timestampWhenActioned,
        bbd.statusBbdChecked AS status,
        bbd.creationUserBC AS creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser
      FROM bbd_first_occurence_in_checked_aux bbd
      WHERE bbd.statusBbdChecked = 'DONE' AND bbd.quantity = 0 --AND previousStatus = 'OPEN'

      UNION ALL

      -- 2
      SELECT
        '4' AS cv,
        
        bbd.* EXCEPT (statusBbdChecked, quantity, isChecked, isNotFound, isRemoved, changeDateBC, creationUserBC, creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser),
        quantity_to_be_checked AS quantity,
        calendar.calendarDate AS Date,
        false AS isChecked,
        false AS isNotFound,
        false AS isRemoved,
        NULL AS changeDateBC,
        NULL AS creationUserBC,
        NULL AS timestampWhenActioned,
        'PENDING' AS status,
        NULL AS creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser
      FROM bbd_first_occurence_in_checked_aux bbd
      INNER JOIN calendar ON
        calendar.calendarDate = COALESCE(bbd.dateWhenAddedToCart, bbd.dateWhenNotFound, CURRENT_DATE('Europe/Bucharest')-1)
      WHERE
        dateWhenFirstlyNeededToBeRemoved <= COALESCE(dateWhenAddedToCart, dateWhenNotFound
        )
        AND (bbd.statusBbdChecked = 'OPEN' OR (bbd.statusBbdChecked = 'DONE' AND bbd.quantity = 0) 
        )
        AND bbd.dateWhenFirstlyNeededToBeRemoved <= (CURRENT_DATE('Europe/Bucharest')-1)

      UNION ALL

      SELECT
        '5' AS cv,
        
        bbd2.* EXCEPT (statusBbdChecked, quantity, isChecked, isNotFound, isRemoved, changeDateBC, creationUserBC, timestampWhenActioned, statusMapped, creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser),
        quantity_checked AS quantity, -- (!)
        calendar.calendarDate AS Date,
        isChecked,
        isNotFound,
        isRemoved,
        changeDateBC,
        creationUserBC,
        NULL timestampWhenActioned,
        statusBbdChecked AS status,
        creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser
      FROM bl_joined_bmr_joined_bc_joined_bc_aux_bul bbd2
      INNER JOIN calendar ON
        COALESCE(bbd2.dateWhenAddedToCart, bbd2.dateWhenNotFound) <= calendar.calendarDate
        AND 
        ((bbd2.timestampWhenActioned IS NULL AND calendar.calendarDate <= CURRENT_DATE('Europe/Bucharest')-1)
        OR (bbd2.timestampWhenActioned IS NOT NULL AND calendar.calendarDate < DATE(TIMESTAMP(bbd2.timestampWhenActioned))))
      WHERE
        bbd2.dateWhenFirstlyNeededToBeRemoved <= (CURRENT_DATE('Europe/Bucharest')-1)
        AND bbd2.statusBbdChecked = 'OPEN'

      UNION ALL

      SELECT
        '6' AS cv,
        
        bbd2.* EXCEPT (statusBbdChecked, quantity, isChecked, isNotFound, isRemoved, changeDateBC, creationUserBC, timestampWhenActioned, statusMapped, creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser),
        quantity_checked AS quantity, -- (!)
        DATE(timestampWhenActioned) AS Date,
        isChecked,
        isNotFound,
        isRemoved,
        changeDateBC,
        creationUserBC,
        timestampWhenActioned,
        statusBbdChecked AS status,
        creationUser2, dateWhenNotFound, timestampWhenNotFound, checkUser
      FROM bl_joined_bmr_joined_bc_joined_bc_aux_bul bbd2
      INNER JOIN calendar ON
        COALESCE(bbd2.dateWhenAddedToCart, bbd2.dateWhenNotFound) <= calendar.calendarDate
        AND calendar.calendarDate <= DATE(bbd2.timestampWhenActioned)
      WHERE
        bbd2.dateWhenFirstlyNeededToBeRemoved <= (CURRENT_DATE('Europe/Bucharest')-1)
        AND bbd2.statusBbdChecked = 'DONE' AND bbd2.quantity > 0 AND (checkUser IS NULL OR checkUser NOT IN ('BBDEXPIRED', 'BBDZEROSTOCK'))
    )
  )

SELECT * FROM (
SELECT DISTINCT r.* FROM rows_generated r
LEFT JOIN lld3 ON r.id = lld3.id and lld3.storenumber = r.storenumber
where lld3.id IS NULL
)
-- -bul- _bul _BG '${c.iso2}'


`;

const bbd_operational2_1_XX = (c) => `



WITH
  bbd_merchandise_rules_bul AS (
    SELECT * FROM metro-bi-wb-inventory-s00.Country_dashboards.bbd_merchandise_rules_all_countries
    WHERE countryCode = '${c.iso2}'
  ),

  -- bbd_articles AS (
  --   SELECT DISTINCT bl.storeNumber, articleNumber, bundleNumber, variantNumber FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bl
  --   INNER JOIN bbd_merchandise_rules_bul bmr ON
  --     (bmr.storeNumber = -1 OR bl.storeNumber = bmr.storeNumber)
  --     AND bl.bbdRuleId = bmr.ruleId
  -- ),

  ranked_bbd_list_bul AS (
    SELECT
      countryCode, salesLine, storeNumber,
      bbdRuleId, --id,
      articleNumber, bundleNumber, variantNumber, subsystemArticleNumber, lotNumber,
      bestBeforeDate, changeDate, creationDate, creationUser, changeUser, PARTITIONTIME,
      logicallyDeleted, bbdSource, quantity,
      ROW_NUMBER() OVER (PARTITION BY storeNumber, id, DATE(changedate)
        ORDER BY changeDate DESC, dana_ingestion_timestamp DESC) AS rn,
      id
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\`
    WHERE 1=1
      -- (bbdSource IS NULL OR bbdSource != 'MARKDOWN')
      AND DATE(PARTITIONTIME) >= DATE('2024-01-01') -- year change
      AND (changeUser IS NULL OR changeUser != 'BBD_RULE_REFRESH')
      AND ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
      AND SUBSTR(creationDate, 1, 10) <= CAST(CURRENT_DATE('Europe/Bucharest')-1 AS STRING)
  ),

  bbd_list_bul AS (
    SELECT
      * EXCEPT (rn)
    FROM ranked_bbd_list_bul
    -- WHERE
    --   rn = 1
      -- AND (changeUser IS NULL OR changeUser != 'BBDStockZero') -- changed on 05.09.2024
  ),

  bl_joined_bmr_bul AS (
    SELECT
      bl.countryCode, bl.salesLine, bl.storeNumber,
      bl.bbdRuleId, bl.id, bl.quantity,
      bl.articleNumber, bl.bundleNumber, bl.variantNumber, bl.subsystemArticleNumber, bl.lotNumber,
      bl.bestBeforeDate, bl.changeDate, bl.creationDate, bl.creationUser, bl.bbdSource,
      bl.logicallyDeleted,
      bmr.departmentNumber, bmr.mainMerchandiseGroup, bmr.merchandiseGroup, bmr.merchandiseSubgroup,
      -- CASE
      --   WHEN CAST(bl.bestBeforeDate AS DATE) < (CURRENT_DATE('Europe/Bucharest')-1) THEN true
      --   ELSE false
      -- END AS isBbdDue,
      -- CASE
      --   WHEN (EXTRACT(DATE FROM PARSE_DATETIME('%Y-%m-%d', bl.bestBeforeDate)) - bmr.gracePeriod) <= (CURRENT_DATE('Europe/Bucharest')-1) THEN true
      --   ELSE false
      -- END AS shouldBeChecked,
      bmr.gracePeriod, EXTRACT(DATE FROM PARSE_DATETIME('%Y-%m-%d', bl.bestBeforeDate)) - bmr.gracePeriod AS dateEnteringGracePeriod,
      -- MIN(GREATEST(DATE(bl.changeDate), EXTRACT(DATE FROM PARSE_DATETIME('%Y-%m-%d', bl.bestBeforeDate)) - bmr.gracePeriod))
      --   OVER (PARTITION BY bl.storeNumber, bl.articleNumber, bl.bundleNumber, bl.variantNumber, 
      --   bl.subsystemArticleNumber, bl.bestBeforeDate) AS dateWhenFirstlyNeededToBeRemoved -- grace period might
      --     -- have been already started, but it doesn't matter - because the article might not yet be found in bbd_list
      MIN(GREATEST(DATE(bl.changeDate), EXTRACT(DATE FROM PARSE_DATETIME('%Y-%m-%d', bl.bestBeforeDate)) - bmr.gracePeriod))
        OVER (PARTITION BY bl.storeNumber, bl.id) AS dateWhenFirstlyNeededToBeRemoved -- grace period might
          -- have been already started, but it doesn't matter - because the article might not yet be found in bbd_list
    FROM bbd_list_bul bl
    INNER JOIN bbd_merchandise_rules_bul bmr ON
      bmr.countryCode = bl.countryCode 
      AND bmr.ruleId = bl.bbdRuleId AND (bmr.storeNumber IS NULL OR bl.storeNumber = bmr.storeNumber)
      AND bmr.activeFrom <= TIMESTAMP(bl.creationDate) AND TIMESTAMP(bl.creationDate) <= bmr.activeTo
      AND bmr.active = true
  ),

  bbd_missing AS (
    SELECT * FROM (
      SELECT
        DISTINCT bm.* EXCEPT (dana_ingestion_timestamp, PARTITIONTIME, logicallyDeleted),
        MAX(hasBbd) OVER (PARTITION BY bm.storeNumber, bm.subsystemArticleNumber, bm.missingDate, bm.changeDate
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS wasBbdAdded,
      FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_missing\` bm
      INNER JOIN bbd_merchandise_rules_bul bmr ON
        bmr.countryCode = bm.countryCode 
        AND bmr.ruleId = bm.bbdRuleId AND (bmr.storeNumber IS NULL OR bm.storeNumber = bmr.storeNumber)
        AND bmr.activeFrom <= TIMESTAMP(bm.creationDate) AND TIMESTAMP(bm.creationDate) <= bmr.activeTo
        AND bmr.active = true
    WHERE
      DATE(bm.PARTITIONTIME) >= DATE('2024-01-01') -- year change
      AND ((NOT STARTS_WITH(creationDate, '200')) AND (NOT STARTS_WITH(creationDate, '201')) AND (NOT STARTS_WITH(creationDate, '2020'))
        AND (NOT STARTS_WITH(creationDate, '2021')) AND (NOT STARTS_WITH(creationDate, '2022')))
      AND SUBSTR(creationDate, 1, 10) <= CAST(CURRENT_DATE('Europe/Bucharest')-1 AS STRING)
      AND (changeUser IS NULL OR changeUser NOT IN ('BBDStockZero', 'BBD_RULE_REFRESH'))
    )
    WHERE hasBbd = wasBbdAdded -- adaugat pe 2024-10-10 pt ca daca din article search si faci remove si dai add, practic articolul nu mai e
      -- in tab-ul de missing si atunci practic ultimul hasBbd e YES, de asta am pus MAX(hasBbd)
  ),

  bm_is_bbd_missing_added AS (
    SELECT *
    -- EXCEPT (rn)
    FROM (
      SELECT
        *,
        true AS isBbdMissing,
        -- ROW_NUMBER() OVER (PARTITION BY storeNumber, subsystemArticleNumber, creationDate ORDER BY changeDate DESC) AS rn
      FROM bbd_missing
      WHERE
        -- hasBbd = 'NO' AND creationUser NOT IN ('BBDExpired', 'BBDStockZero')
        hasBbd = 'NO' AND creationUser NOT IN ('BBDStockZero') -- am modificat aici, pt ca dupa ce un articol care venea din missing, a expirat in tab-ul de remove, se intoarce in tab-ul de missing 04.10.2024
    )
    -- WHERE
    --   rn = 1
    UNION ALL
    SELECT *
    -- EXCEPT (rn)
    FROM (
      SELECT
        *,
        false AS isBbdMissing,
        -- ROW_NUMBER() OVER (PARTITION BY storeNumber, subsystemArticleNumber, creationDate ORDER BY changeDate DESC) AS rn
      FROM bbd_missing
      WHERE
        hasBbd = 'YES'
    )
    -- WHERE
    --   rn = 1
      -- AND hasBbd = 'YES'
  ),

  bc_for_bm AS (
    SELECT
      *
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\`
    WHERE
      DATE(creationDate) >= DATE('2024-01-01') -- year change
  ),

  bm_joined_bc AS (
    SELECT
      bm_temp.* EXCEPT (changeDate), bm_temp.changeDate AS changeDateMissing, bc_temp.quantity, bc_temp.status, bc_temp.changeDate AS changeDateChecked, bc_temp.bbdCheckId,
    FROM bm_is_bbd_missing_added bm_temp
    LEFT JOIN bc_for_bm bc_temp ON
      bm_temp.storeNumber = bc_temp.storeNumber
      AND bm_temp.subsystemArticleNumber = bc_temp.subsystemArticleNumber
      AND TIMESTAMP(bm_temp.changeDate) >= TIMESTAMP(bc_temp.changeDate)
    WHERE
      bm_temp.hasBbd = 'NO'
  ),

  bm_joined_bc_last_status_per_id AS (
    SELECT * EXCEPT (rn, quantity), CASE WHEN status = 'DONE' THEN 0 ELSE quantity END AS quantity FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY storeNumber, subsystemArticleNumber, changeDateMissing, bbdCheckId
          ORDER BY changeDateChecked DESC, status ASC) AS rn
      FROM bm_joined_bc
      WHERE changeDateChecked IS NOT NULL 
    )
    WHERE
      rn = 1
      -- AND status = 'OPEN'
    UNION ALL
    SELECT * EXCEPT(quantity), 0 AS quantity FROM bm_joined_bc WHERE changeDateChecked IS NULL
  ),

  bm_joined_bc_last_status_per_id_quantity AS (
    SELECT
      SUM(quantity) OVER (PARTITION BY storeNumber, subsystemArticleNumber, changeDateMissing
        ORDER BY changeDateChecked ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS quantityInActions,
      *
    FROM bm_joined_bc_last_status_per_id
  ),

  bm_with_latest_quantity AS (
    SELECT * EXCEPT (rn, changeDateMissing), changeDateMissing AS changeDate FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY storeNumber, subsystemArticleNumber, changeDateMissing
          ORDER BY changeDateChecked DESC) AS rn
      FROM  bm_joined_bc_last_status_per_id_quantity
    )
    WHERE rn = 1
  ),

  -- bc_for_bm AS (
  --   SELECT
  --     SUM(quantity) OVER (PARTITION BY storeNumber, subsystemArticleNumber
  --       ORDER BY changeDate ASC
  --       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS quantityInActionsUntilNow,
  --     *
  --   FROM (
  --     SELECT * EXCEPT (rn) FROM (
  --       SELECT
  --         ROW_NUMBER() OVER (PARTITION BY storeNumber, bbdCheckId 
  --           ORDER BY changeDate DESC, status ASC) AS rn,
  --         *
  --       FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\`
  --       WHERE
  --         DATE(creationDate) >= DATE('2023-01-01')
  --     )
  --     WHERE
  --       rn = 1
  --       AND status = 'OPEN'
  --   )
  -- ),

  -- neww0 AS (
  --   SELECT
  --     bm_temp.*, COALESCE(bc_temp.quantityInActionsUntilNow, 0) AS quantityInActions, bc_temp.changeDate AS changeDateChecked,
  --   FROM bm_is_bbd_missing_added bm_temp
  --   LEFT JOIN bc_for_bm bc_temp ON
  --     bm_temp.storeNumber = bc_temp.storeNumber
  --     AND bm_temp.subsystemArticleNumber = bc_temp.subsystemArticleNumber
  --     AND TIMESTAMP(bm_temp.changeDate) >= TIMESTAMP(bc_temp.changeDate)
  --   WHERE
  --     bm_temp.hasBbd = 'NO'
  -- ),



  -- neww2 AS (
  --   SELECT * EXCEPT (changeDateChecked) FROM neww0 WHERE changeDateChecked IS NULL
  --   UNION ALL
  --   SELECT * EXCEPT (rn) FROM (
  --     SELECT
  --       ROW_NUMBER() OVER (PARTITION BY storeNumber, subsystemArticleNumber, missingDate, changeDate
  --           ORDER BY changeDateChecked DESC) AS rn,
  --       * EXCEPT (changeDateChecked)
  --     FROM neww0
  --     WHERE changeDateChecked IS NOT NULL
  --   )
  --   WHERE rn = 1
  -- ),

  bm_bc AS (
    SELECT * EXCEPT (status, changeDateChecked, bbdCheckId, quantity) FROM bm_with_latest_quantity WHERE hasBbd = 'NO'
    UNION ALL
    SELECT NULL AS quantityInActions, * EXCEPT (changeDate), changeDate  FROM bm_is_bbd_missing_added WHERE hasBbd = 'YES'
  ),



  b AS (
    SELECT
      bm.*,
      bl.changeDate AS changeDateBL,
      bl.bestBeforeDate,
      bl.id,
      bl.lotNumber, bl.creationDate AS creationDateBL, bl.bbdSource,
      CASE
        WHEN bl.quantity = 0 THEN NULL
        ELSE bl.quantity
      END AS quantityManipulated,
      -- bl.quantity AS quantityManipulated,
      -- bm.countryCode || bm.storeNumber || bm.articleNumber|| bm.bundleNumber|| bm.variantNumber || bm.subsystemArticleNumber || COALESCE(bl.changeDate, bm.changeDate) || bm.tool ||
      --   COALESCE(bl.bestBeforeDate, 'NO_BBD') AS PK
    FROM bm_bc bm
    -- LEFT JOIN \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bl ON
    LEFT JOIN bbd_list_bul bl ON
      bm.storeNumber = bl.storeNumber
      AND bm.subsystemArticleNumber = bl.subsystemArticleNumber
      AND ABS(TIMESTAMP_DIFF(TIMESTAMP(bm.changeDate), TIMESTAMP(bl.creationDate), second)) IN (0, 1)
      AND DATE(bm.missingDate) = DATE(TIMESTAMP(bl.changeDate)) -- <3 am pus creationDate in loc de changeDate; am schimbat iar in changeDate 16.09.2024
      AND bm.isBbdMissing = false
      -- AND bl.bbdSource = 'BbdCheck' -- ? las si conditia asta sau nu?
      AND ((bl.changeUser IS NULL OR bl.creationUser IS NULL) OR (bl.changeUser != 'BBDExpired' AND bl.creationUser != 'BBDExpired')) -- <3
      AND ((bl.changeUser IS NULL OR bl.changeUser != 'BBD_RULE_REFRESH')) -- (!)
    WHERE
      -- bbdSource != 'MARKDOWN'
      ((NOT STARTS_WITH(bl.creationDate, '200')) AND (NOT STARTS_WITH(bl.creationDate, '201'))
        AND (NOT STARTS_WITH(bl.creationDate, '2020')) AND (NOT STARTS_WITH(bl.creationDate, '2021'))
        AND (NOT STARTS_WITH(bl.creationDate, '2022')))
      AND SUBSTR(bl.creationDate, 1, 10) <= CAST(CURRENT_DATE('Europe/Bucharest')-1 AS STRING)
      AND isBbdMissing = false
      AND logicallyDeleted = false
    UNION ALL
    SELECT
      bm.*, NULL AS changeDateBL, NULL AS bestBeforeDate, NULL AS id, NULL AS lotNumber, NULL AS creationDateBL, NULL AS bbdSource,
      NULL AS quantityManipulated
    FROM bm_bc bm
    WHERE isBbdMissing = true
  )
  ,

  c AS (
    SELECT
      CASE WHEN bestBeforeDate IS NULL THEN 'NO' ELSE 'YES' END AS hasBbdNew,
      CASE WHEN bestBeforeDate IS NULL THEN 'bbd_missing' ELSE 'bbd_added' END AS tool,
      *
    FROM b
    WHERE NOT(coalesce(bestBeforeDate, '') = '' AND coalesce(changeUser, '') = 'BBD_RULE_REFRESH')
  ),

  bbd_missing_enhanced AS (
    SELECT
      *,
      LEAD(hasBbdNew) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, subsystemArticleNumber
        ORDER BY changeDate ASC) AS nextBbd,
      LEAD(DATE(TIMESTAMP(missingDate))) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, subsystemArticleNumber
        ORDER BY changeDate ASC) AS nextMissingDate,
      LAG(hasBbdNew) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, subsystemArticleNumber
        ORDER BY changeDate ASC) AS prevBbd,
      LAG(DATE(TIMESTAMP(missingDate))) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, subsystemArticleNumber
        ORDER BY changeDate ASC) AS prevMissingDate,
      ROW_NUMBER() OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, subsystemArticleNumber
        ORDER BY changeDate ASC) AS numberedChangeDate,
    FROM c
  ),

  ranked_bm_boolbbdAdded AS (
    SELECT
      CASE
        WHEN hasBbdNew = 'YES' AND (nextBbd = 'NO' OR nextBbd IS NULL) THEN 1
        WHEN hasBbdNew = 'YES' AND (nextBbd = 'YES' OR nextBbd IS NULL) AND DATE(missingDate) != nextMissingDate THEN 1
        WHEN hasBbdNew = 'YES' AND (nextBbd = 'YES' OR nextBbd IS NULL) AND DATE(missingDate) = nextMissingDate THEN 0
        -- WHEN (hasBbdNew = 'YES' AND nextBbd = 'YES') THEN 1
        WHEN (hasBbdNew = 'NO') THEN 0
        -- changed 06.09.2024
        -- inainte era:
        -- WHEN hasBbdNew = 'YES' AND (nextBbd = 'NO' OR nextBbd IS NULL) THEN 1
        -- WHEN (hasBbdNew = 'YES' AND nextBbd = 'YES') THEN 1
        -- WHEN (hasBbdNew = 'NO') THEN 0
      END AS boolBbd,
      *
    FROM bbd_missing_enhanced
  ),

  ranked_bm_sumbbdAdded AS (
    SELECT
      COALESCE(SUM(boolBbd) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, subsystemArticleNumber
        ORDER BY numberedChangeDate ASC
        RANGE BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS sumBbd,
      *
    FROM ranked_bm_boolbbdAdded
  ),

  bbdSource_numbered AS (
    SELECT
      *,
      CASE WHEN bbdSource = 'BbdCheck' THEN 100 ELSE 0 END AS bbdSourceNumbered
    FROM ranked_bm_sumbbdAdded
  ),

  ranked_bm_actualCreationDate_added AS (
    SELECT
      FIRST_VALUE(missingDate) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, sumBbd
        ORDER BY changeDate ASC) AS creationDateActual,
      FIRST_VALUE(changeDate) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, sumBbd
        ORDER BY changeDate ASC) AS creationTimestampActual,
      MAX(bbdSourceNumbered) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, sumBbd) AS bbdSourceNumberedMax,
        -- changed 05.09.2024, era de FIRST_VALUE(creationDate), care e cu o zi in urma din cauza timezone-ului
        -- MIN(bbdSource) will take value 'BbdCheck' if it exists, otherwise will take any other, which is automatic
        -- and shouldn't be included in the usage computation. this is needed in case there are multiple entries in bbd_list
        -- and some of them are for example MARKDOWN or MMSSTORE and they should be excluded
      MAX(bbdSource) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, sumBbd) AS bbdSourceMax,
      MIN(Tool) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, sumBbd) AS isAdded,
      MIN(Tool) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber, sumBbd, missingDate) AS isAddedOnMissingDate,
      
      *
    FROM bbdSource_numbered
  ),

  proc AS (
    SELECT
      CASE WHEN bbdSourceNumberedMax = 100 THEN 'BbdCheck' ELSE bbdSourceMax END AS bbdSourceFinal,
      *
    FROM ranked_bm_actualCreationDate_added
  ),

  markdown_and_mmsstore_removed AS (
    SELECT * FROM proc
    WHERE
      (isAddedOnMissingDate = 'bbd_missing' ) --AND bbdSourceFinal IS NOT NULL)
      OR (
        isAddedOnMissingDate = 'bbd_added'
        AND bbdSourceFinal NOT IN ('MMSSTORE', 'MMSSTORE_INITIAL_LOAD', 'MARKDOWN')
        AND (bbdSource IS NULL OR bbdSource NOT IN ('MMSSTORE', 'MMSSTORE_INITIAL_LOAD', 'MARKDOWN'))
      )

      -- -- (bbdSourceFinal IS NULL OR bbdSourceFinal NOT IN ('MARKDOWN', 'MMSSTORE'))
      -- -- OR (bbdSource IS NULL OR bbdSource NOT IN ('MARKDOWN', 'MMSSTORE'))  -- am schimbat din AND in OR (prima chestie de pe rand)
      -- (bbdSourceFinal IS NULL OR bbdSourceFinal NOT IN ('MMSSTORE', 'MARKDOWN'))
      -- OR (bbdSource IS NULL OR bbdSource NOT IN ('MMSSTORE', 'MARKDOWN'))  -- am schimbat din AND in OR (prima chestie de pe rand)
      -- -- am eliminat MMSSTORE de test, 03.10.2024
  ),

  actualCreationDate_corrected AS (
    SELECT
      * EXCEPT (creationDateActual),
      CASE WHEN hasBbdNew = 'YES' AND DATE(missingDate) != prevMissingDate THEN creationDate ELSE creationDateActual END AS creationDateActual
    FROM markdown_and_mmsstore_removed
  ),

  cc AS (
    SELECT *,
      countryCode || storeNumber || articleNumber || bundleNumber || variantNumber || subsystemArticleNumber
        || COALESCE(bestBeforeDate, 'NO_BBD') || missingDate || tool                                                               AS PK,
      countryCode || storeNumber || articleNumber || bundleNumber || variantNumber || subsystemArticleNumber || creationDateActual AS PK2,
      countryCode || storeNumber || articleNumber || bundleNumber || variantNumber || subsystemArticleNumber                       AS PK3,
      -- countryCode || storeNumber || articleNumber|| bundleNumber|| variantNumber || subsystemArticleNumber || missingDate || tool  AS PK4special,
      countryCode || storeNumber || articleNumber|| bundleNumber|| variantNumber || subsystemArticleNumber || missingDate || tool ||creationTimestampActual AS PK4special,
      countryCode || storeNumber || articleNumber|| bundleNumber|| variantNumber || subsystemArticleNumber || missingDate ||creationTimestampActual AS PK4special2,
      countryCode || storeNumber || articleNumber|| bundleNumber|| variantNumber || subsystemArticleNumber || missingDate AS PKmissing,
    FROM actualCreationDate_corrected

  ),

  articles AS (
    SELECT DISTINCT storeNumber, articleNumber, bundleNumber, variantNumber FROM cc
  ),


------------->
  system_stock AS (
    SELECT
      country, locationID, articleNo, bundleNo, variant, dataGroup, totalQuantity AS systStock, bookingTimestamp
    FROM (
      SELECT
        country, locationID, articleNo, bundleNo, variant, dataGroup, totalQuantity, bookingTimestamp,
        ROW_NUMBER() OVER (PARTITION BY locationID, articleNo, variant, bundleNo, bookingTimestamp
          ORDER BY bookingTimestamp DESC, sequence DESC) AS rn
      FROM \`${projectFor(c.internal)}.ingest_movie.stock_events\` stock
      -- INNER JOIN bbd_articles ON
      --   stock.locationId = bbd_articles.storeNumber
      --   AND stock.articleNo = bbd_articles.articleNumber
      --   AND stock.bundleNo = bbd_articles.bundleNumber
      --   AND stock.variant = bbd_articles.variantNumber
      -- INNER JOIN articles ON
      --   stock.locationId = articles.storeNumber
      --   AND stock.articleNo = articles.articleNumber
      --   AND stock.bundleNo = articles.bundleNumber
      --   AND stock.variant = articles.variantNumber
      WHERE
        PARTITIONTIME >= TIMESTAMP('2024-07-01')
        AND DATE(PARTITIONTIME) <= CURRENT_DATE('Europe/Bucharest')-1
        AND datagroup = 'SYST'
    ) s
    WHERE
      s.rn = 1
  ),

  markdown_stock AS (
    SELECT
      country, locationID, articleNo, bundleNo, variant, totalQuantity AS madoStock, bookingTimestamp
    FROM (
      SELECT
        country, locationID, articleNo, bundleNo, variant, dataGroup, totalQuantity, bookingTimestamp,
        ROW_NUMBER() OVER (PARTITION BY locationID, articleNo, variant, bundleNo, bookingTimestamp
          ORDER BY bookingTimestamp DESC, sequence DESC) AS rn
      FROM \`${projectFor(c.internal)}.ingest_movie.stock_events\` stock
      WHERE
        PARTITIONTIME >= TIMESTAMP('2024-07-01')
        AND DATE(PARTITIONTIME) <= CURRENT_DATE('Europe/Bucharest')-1
        AND datagroup = 'MADO'
    ) s
    WHERE
      s.rn = 1
  ),

  bbd_missing_aux_syst1 AS (
    SELECT
      -- bm.countryCode, bm.salesLine, bm.storeNumber, bm.departmentNumber, bm.mainMerchandiseGroup, bm.merchandiseGroup, bm.merchandiseSubgroup,
      -- bm.articleNumber, bm.bundleNumber, bm.variantNumber, bm.subsystemArticleNumber, ss.systStock, bm.hasBbd, bm.nextBbd, bm.sumBbd, bm.gracePeriod,
      -- bm.missingDate, bm.changeDate, bm.creationDate, bm.changeUser, bm.creationDateActual, ss.bookingTimestamp AS systStockDate
      bm.*, ss.systStock, ss.bookingTimestamp AS systStockDate
    FROM cc bm
    LEFT JOIN system_stock ss ON
      bm.storeNumber = ss.locationID
      AND bm.articleNumber = ss.articleNo
      AND bm.bundleNumber = ss.bundleNo
      AND bm.variantNumber = ss.variant
      AND TIMESTAMP(bm.changeDate) >= ss.bookingTimestamp
      AND DATE(ss.bookingTimestamp) >= DATETIME_SUB(DATE(bm.changeDate), INTERVAL 6 MONTH)
      -- AND DATE_DIFF(DATE(changeDate), DATE(ss.bookingTimestamp), month) <= 6


  ),

  bbd_missing_aux_syst2 AS (
    SELECT *
    EXCEPT (rnnnn)
    FROM (
      SELECT 
        *,
        RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY systStockDate DESC) AS rnnnn
        -- RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY systStockDate DESC) AS rnnnn
        -- very important that it's rank instead of row_number. It's because on one missingDate there are multiple changeDates, for example one YES followed by one NO.
      FROM bbd_missing_aux_syst1
    )
    WHERE rnnnn = 1
  )
  ,

  bbd_missing_aux_mado1 AS (
    SELECT 
      -- bm.countryCode, bm.salesLine, bm.storeNumber, bm.departmentNumber, bm.mainMerchandiseGroup, bm.merchandiseGroup, bm.merchandiseSubgroup,
      -- bm.articleNumber, bm.bundleNumber, bm.variantNumber, bm.subsystemArticleNumber, bm.systStock, ms.madoStock,
      -- COALESCE(bm.systStock - ms.madoStock, bm.systStock) AS availableStock, bm.hasBbd, bm.nextBbd, bm.sumBbd, bm.gracePeriod,
      -- bm.missingDate, bm.changeDate, bm.creationDate, bm.changeUser, bm.creationDateActual, bm.systStockDate, ms.bookingTimestamp AS madoStockDate
      bm.*, COALESCE(bm.systStock - ms.madoStock, bm.systStock) AS availableStock2, ms.bookingTimestamp AS madoStockDate, ms.madoStock
    FROM bbd_missing_aux_syst2 bm
    LEFT JOIN markdown_stock ms ON
      bm.storeNumber = ms.locationID
      AND bm.articleNumber = ms.articleNo
      AND bm.bundleNumber = ms.bundleNo
      AND bm.variantNumber = ms.variant
      AND CAST(bm.changeDate AS TIMESTAMP) >= ms.bookingTimestamp
      AND DATE(ms.bookingTimestamp) >= DATETIME_SUB(DATE(bm.changeDate), INTERVAL 6 MONTH)
      -- AND DATE_DIFF(DATE(missingDate), DATE(ms.bookingTimestamp), month) <= 6

  ),

  bbd_missing_aux_mado2 AS (
    SELECT * EXCEPT (rn) 
    FROM (
      SELECT
        *,
        RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY madoStockDate DESC) AS rn
        -- RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY madoStockDate DESC) AS rn
      FROM bbd_missing_aux_mado1
    )
    WHERE
      rn = 1
      -- AND ((hasBbd = 'YES') OR (hasBbd='NO' AND availableStock > 0.1) OR (availableStock IS NULL))
  ),


------------->

  missing_final AS (
  SELECT
    *
  FROM bbd_missing_aux_mado2
  WHERE
    NOT (isAddedOnMissingDate = 'bbd_missing' AND ((systStock - quantityInActions) <= 0) -- OR systStock <= 0 -- de pus inapoi !!!
    )
  ),

  missing_final_aux_syst1 AS (
    SELECT
      bm.*, ss.systStock AS systStockLatestOnTheDay, ss.bookingTimestamp AS systStockDate2
    FROM missing_final bm
    LEFT JOIN system_stock ss ON
      bm.storeNumber = ss.locationID
      AND bm.articleNumber = ss.articleNo
      AND bm.bundleNumber = ss.bundleNo
      AND bm.variantNumber = ss.variant
      AND CAST(CONCAT(bm.missingDate, ' 23:59:59.999999 UTC') AS TIMESTAMP) >= ss.bookingTimestamp
      AND DATE(ss.bookingTimestamp) >= DATETIME_SUB(DATE(bm.missingDate), INTERVAL 6 MONTH)
      -- AND DATE_DIFF(DATE(changeDate), DATE(ss.bookingTimestamp), month) <= 6
  ),

  missing_final_aux_syst2 AS (
    SELECT * EXCEPT (rnn)
    FROM (
      SELECT 
        *,
        RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY systStockDate2 DESC) AS rnn,
        -- RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY systStockDate2 DESC) AS rnn
        -- very important that it's rank instead of row_number. It's because on one missingDate there are multiple changeDates, for example one YES followed by one NO.
      FROM missing_final_aux_syst1
    )
    WHERE rnn = 1
  ),

  missing_final_aux_mado1 AS (
    SELECT 
      bm.*, COALESCE(bm.systStockLatestOnTheDay - ms.madoStock, bm.systStockLatestOnTheDay) AS availableStockLatestOnTheDay, ms.bookingTimestamp AS madoStockDate2, ms.madoStock AS madoStockLatestOnTheDay
    FROM missing_final_aux_syst2 bm
    LEFT JOIN markdown_stock ms ON
      bm.storeNumber = ms.locationID
      AND bm.articleNumber = ms.articleNo
      AND bm.bundleNumber = ms.bundleNo
      AND bm.variantNumber = ms.variant
      AND CAST(CONCAT(bm.missingDate, ' 23:59:59.999999 UTC') AS TIMESTAMP) >= ms.bookingTimestamp
      AND DATE(ms.bookingTimestamp) >= DATETIME_SUB(DATE(bm.missingDate), INTERVAL 6 MONTH)
      -- AND DATE_DIFF(DATE(missingDate), DATE(ms.bookingTimestamp), month) <= 6

  ),

  missing_final_aux_mado2 AS (
    SELECT * EXCEPT (rn) 
    FROM (
      SELECT
        *,
        RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY madoStockDate2 DESC) AS rn
        -- RANK() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, changeDate ORDER BY madoStockDate2 DESC) AS rn
      FROM missing_final_aux_mado1
    )
    WHERE
      rn = 1
      -- AND ((hasBbd = 'YES') OR (hasBbd='NO' AND availableStock > 0.1) OR (availableStock IS NULL))
  ),

  missing_removed_end_of_day AS (
    SELECT * FROM missing_final_aux_mado2
    WHERE
      NOT (Tool = 'bbd_missing' AND availableStockLatestOnTheDay <= 0.1)
  ),

------>

  d AS (
    SELECT
      CASE WHEN hasBbdNew = 'NO' THEN 1 ELSE 2 END AS hasBbdRank,
      *
    FROM missing_removed_end_of_day
  ),

  e AS (
    SELECT
      ROW_NUMBER() OVER (PARTITION BY PKmissing ORDER BY hasBbdRank ASC) AS rn,
      *
    FROM d
  ),




  -- f AS (
  --   SELECT PKmissing, COUNT(DISTINCT hasBbdNew) AS n_hasBbd, MAX(hasBbdNew) AS hasBbdNewMax,
  --   CASE WHEN COUNT(DISTINCT hasBbdNew) = 1 AND MAX(hasBbdNew) = 'YES' THEN 1 ELSE 0 END AS isAddedDirectly,
  --   FROM d
  --   GROUP BY 1
  --   -- 5 479 292 / 144 769 303 = 3.78%
  -- ),

  -- g AS (
  --   SELECT e.*, f.isAddedDirectly FROM e INNER JOIN f ON e.PKmissing = f.PKmissing
  -- ),

  f AS (
    -- SELECT PKmissing, COUNT(DISTINCT hasBbdNew) AS n_hasBbd, MAX(hasBbdNew) AS hasBbdNewMax,
    SELECT PK4special2, COUNT(DISTINCT hasBbdNew) AS n_hasBbd, MAX(hasBbdNew) AS hasBbdNewMax,
    CASE WHEN COUNT(DISTINCT hasBbdNew) = 1 AND MAX(hasBbdNew) = 'YES' THEN 1 ELSE 0 END AS isAddedDirectly,
    FROM d
    GROUP BY 1
    -- 5 479 292 / 144 769 303 = 3.78%
  ),

  g AS (
    -- SELECT e.*, f.isAddedDirectly FROM e INNER JOIN f ON e.PKmissing = f.PKmissing
    SELECT e.*, f.isAddedDirectly FROM e INNER JOIN f ON e.PK4special2 = f.PK4special2
  ),

  h AS (
    SELECT *, MAX(bestBeforeDate) OVER (PARTITION BY countryCode, storeNumber, subsystemArticleNumber, creationDateActual) AS bestBeforeDateRetro
    FROM g
  ),

  bbd_missing_bmr AS (
    SELECT
      -- bm.countryCode, bm.salesLine, bm.storeNumber, bmr.departmentNumber,
      -- bmr.mainMerchandiseGroup, bmr.merchandiseGroup, bmr.merchandiseSubgroup,
      -- bm.articleNumber, bm.bundleNumber, bm.variantNumber, bm.subsystemArticleNumber, bm.hasBbd, bm.nextBbd, bm.sumBbd, bmr.gracePeriod,
      -- bm.missingDate, bm.changeDate, bm.creationDate, bm.changeUser, bm.creationDateActual
      bm.* EXCEPT (departmentNumber, mainMerchandiseGroup, merchandiseGroup, merchandiseSubgroup),
      COALESCE(bm.departmentNumber, bmr.departmentNumber) AS departmentNumber,
      COALESCE(bm.mainMerchandiseGroup, bmr.mainMerchandiseGroup) AS mainMerchandiseGroup,
      COALESCE(bm.merchandiseGroup, bmr.merchandiseGroup) AS merchandiseGroup,
      COALESCE(bm.merchandiseSubgroup, bmr.merchandiseSubgroup) AS merchandiseSubgroup,
      bmr.gracePeriod
    FROM h bm
    INNER JOIN bbd_merchandise_rules_bul bmr ON
      bmr.countryCode = bm.countryCode 
      AND bmr.ruleId = bm.bbdRuleId AND (bmr.storeNumber IS NULL OR bm.storeNumber = bmr.storeNumber)
      AND bmr.activeFrom <= TIMESTAMP(bm.creationDate) AND TIMESTAMP(bm.creationDate) <= bmr.activeTo
      AND bmr.active = true
  ),
  -- -bul- _bul



  final AS (
    SELECT 
      CASE
        WHEN bm.tool = 'bbd_added' THEN 1
        ELSE 0
      END AS bbdAdded,
      1 AS bbdAll,
      a.art_name,
      bm.*,
    FROM bbd_missing_bmr bm
    LEFT JOIN \`${projectFor(c.internal)}.cc_dwh.dw_article\` a ON
      bm.articleNumber = a.art_no
  ),


  final6 AS (
    SELECT
      CASE
        WHEN bbdAdded = 1 THEN 1
        ELSE 0
      END AS toolOrder,
      *
    FROM final
  ),

  final7 AS (
    SELECT
      *,
      (case
        when Tool in ('bbd_missing', 'bbd_to_be_checked') then null
        else DATE_DIFF(DATE(missingDate), DATE(creationDateActual), day)
      end) AS Days_to_execution_counter,
      case when gracePeriod = 0 then 1 else gracePeriod end as gracePeriodNonZero
    FROM final6
  ),

  departments AS (
    SELECT
      Country, Department_number,
      CONCAT(CASE WHEN Country IN ('ES', 'PT', 'RO', 'UA') THEN Department_number_3digits ELSE Department_number_2digits END, '. ',
        Department_Description) AS Department_Description
    FROM (
      SELECT
        * EXCEPT (Department_Description),
        CASE
          WHEN Department_number / 10 < 1 THEN CONCAT('00', Department_number)
          WHEN Department_number / 10 >= 1 AND Department_number / 10 < 10 THEN CONCAT('0', Department_number)
          WHEN Department_number / 10 >= 10 AND Department_number / 10 < 100 THEN CAST(Department_number AS STRING)
          ELSE CAST(Department_number AS STRING)
        END AS Department_number_3digits,
        CASE
          WHEN Department_number / 10 < 1 THEN CONCAT('0', Department_number)
          WHEN Department_number / 10 >= 1 AND Department_number / 10 < 10 THEN CAST(Department_number AS STRING)
          ELSE CAST(Department_number AS STRING)
        END AS Department_number_2digits,
        SPLIT(Department_Description, '. ')[1] AS Department_Description
      FROM metro-bi-wb-inventory-s00.customization.departments_new 
    )
  ),
  
  missing as (
SELECT
  a.*,
  b.department_description                                                                                AS Department_name,
  CASE
    WHEN LENGTH(CAST(a.Store_no AS STRING)) = 1 THEN CONCAT('0', a.Store_no, '. ', c.store_desc)
    ELSE CONCAT(a.Store_no, '. ', c.store_desc)
  END                                                                                                     AS Store_name
FROM (
  SELECT
    countryCode || storeNumber || articleNumber || bundleNumber || variantNumber || subsystemArticleNumber
     || COALESCE(bestBeforeDateRetro, 'NO_BBD') || missingDate || tool                                     AS PK,
    -- storeNumber || articleNumber || bundleNumber || variantNumber || subsystemArticleNumber
    --  || COALESCE(bestBeforeDateRetro, 'NO_BBD') || tool                                                   AS PK1,
    countryCode || storeNumber || creationDateActual || articleNumber || bundleNumber
      || variantNumber || subsystemArticleNumber                                                           AS PK2,
    -- PK2 defines a set of tasks (e.g. a bbd missing since a few days ago = a set of tasks)
    countryCode || storeNumber || articleNumber || bundleNumber || variantNumber || subsystemArticleNumber AS PK3,
    -- countryCode || storeNumber || articleNumber || bundleNumber || variantNumber
    --   ||  subsystemArticleNumber || missingDate || tool                                                    AS PK4special,
    -- countryCode || storeNumber || articleNumber || bundleNumber || variantNumber
    --   ||  subsystemArticleNumber || changeDate                                                    AS PK4special, -- changed 30.10.2024
    countryCode || storeNumber || articleNumber || bundleNumber || variantNumber
      ||  subsystemArticleNumber || creationTimestampActual                                                    AS PK4special, -- changed 05.11.2024
    countryCode || storeNumber || creationDateActual || articleNumber || bundleNumber
      || variantNumber || subsystemArticleNumber                                                           AS PK5notactioned,
    'NO_ID' AS id,
    isAddedDirectly AS Is_added_directly,
    countryCode                                                                                            AS Country,
    DATE(missingDate)                                                                                      AS Date,
    TIMESTAMP('1970-01-01 00:00:00')                                                                       AS Timestamp_task_completion,
    DATE(creationDateActual)                                                                               AS Creation_date,
    TIMESTAMP(creationTimestampActual)                                                                     AS Creation_timestamp,
    changeDate                                                                                             AS Change_date,
    -- lastUpdatedDate                                                                                       AS Last_updated_date,
    -- ROUND(TIMESTAMP_DIFF(CAST(lastUpdatedDate AS TIMESTAMP), CAST(creationDateActual AS TIMESTAMP), hour) / 24, 2) AS Solving_time_in_days,
    -- daysSincePublishedToListTillBbdAddedOrQueryRunDate                              AS Days_since_published_to_list_till_bbd_added_or_query_run_date,
    bestBeforeDate                                                                  AS Best_before_date,
    bestBeforeDateRetro                                                             AS Best_before_date_retro,
    -- changeDate                                                                      AS Change_date,
    storeNumber                                                                     AS Store_no,
    departmentNumber                                                                AS Department_no,
    'ingest_inventory, ingest_movie'                                                AS Data_source,
    tool                                                                            AS Tool,
    tool                                                                            AS Tool_general,
    bbdSource                                                                       AS Bbd_source,
    changeUser                                                                      AS Creation_user,
    CASE
      WHEN changeUser LIKE '%@%' OR changeUser LIKE '% %' THEN 'User'
      ELSE changeUser
    END                                                                             AS User_type,
    CASE
      WHEN bbdAdded = 1 THEN 0
      ELSE 1
    END                                                                             AS Day_usage_counter_ADDED,
    NULL                                                                            AS Day_usage_counter_REMOVED,
    NULL                                                                            AS Day_usage_counter_ACTIONED,
    DATE_DIFF(DATE(bestBeforeDate), DATE(missingDate), day)                         AS Day_expiry_counter,
    Days_to_execution_counter AS Days_to_execution_counter,
    -- case
    --   when Days_to_execution_Counter>gracePeriod then "Expired-no action"
    --   when Days_to_execution_Counter/gracePeriodNonZero<=0.33 then 'Fast actioned'
    --   when Days_to_execution_Counter/gracePeriodNonZero>0.66 then 'Slow actioned'
    --   when Days_to_execution_Counter/gracePeriodNonZero > 0.33 and Days_to_execution_Counter/gracePeriodNonZero <= 0.66 then 'Medium actioned'
    --   WHEN Days_to_execution_Counter IS NULL THEN 'Not actioned yet' end            AS Reaction_time,
    CASE
      WHEN tool = 'bbd_missing' THEN 'Not yet actioned'
      WHEN tool = 'bbd_added' THEN NULL
    END                                                                             AS Reaction_time,
    art_name                                                                        AS Article_name,
    (articleNumber * 1000000) + (variantNumber * 1000) + bundleNumber               AS Article_id,
    subsystemArticleNumber                                                          AS Article_no,
    articleNumber, variantNumber, bundleNumber, hasBbdNew, isAddedOnMissingDate,
    quantityManipulated                                                             AS Quantity_manipulated,
    availableStock2                                                                 AS Available_stock,
    systStock                                                                       AS Syst_stock,
    madoStock                                                                       AS Mado_stock,
    systStockLatestOnTheDay,
    systStockDate2 AS systStockDateLatestOnTheDay,
    madoStockLatestOnTheDay,
    madoStockDate2 AS madoStockDateLatestOnTheDay,
    availableStockLatestOnTheDay,
    quantityInActions                                                               AS Quantity_in_actions,
    gracePeriod                                                                     AS Grace_period,
    lotNumber                                                                       AS Lot_number,
    mainMerchandiseGroup                                                            AS PMMG,
    merchandiseGroup                                                                AS PMG,
    merchandiseSubgroup                                                             AS PMsG,
    toolOrder--, maxTool
  FROM final7
  WHERE
    1=1
    -- AND storeNumber NOT IN (83,84,85,86)
) a
LEFT JOIN departments b ON a.Country = b.country AND a.Department_no = b.Department_number
LEFT JOIN (
  SELECT DISTINCT
    countrycode,
    store_no,
    store_desc
  FROM metro-bi-wb-inventory-s00.customization.labels1
) c ON a.Country = c.countrycode AND a.Store_no = c.store_no
)

SELECT * FROM missing

`;

const bbd_operational2_XX = (c) => `

WITH
  bbd_merchandise_rules_bul AS (
    SELECT * FROM metro-bi-wb-inventory-s00.Country_dashboards.bbd_merchandise_rules_all_countries
    WHERE countryCode = '${c.iso2}'
  ),

  missing AS (
    SELECT * FROM metro-bi-wb-inventory-s00.Country_dashboards.bbd_operational2_1_daily_${c.iso2}
    WHERE Date >= DATE('2025-01-01') -- year change
  ),

  departments AS (
    SELECT
      Country, Department_number,
      CONCAT(CASE WHEN Country IN ('ES', 'PT', 'RO', 'UA') THEN Department_number_3digits ELSE Department_number_2digits END, '. ',
        Department_Description) AS Department_Description
    FROM (
      SELECT
        * EXCEPT (Department_Description),
        CASE
          WHEN Department_number / 10 < 1 THEN CONCAT('00', Department_number)
          WHEN Department_number / 10 >= 1 AND Department_number / 10 < 10 THEN CONCAT('0', Department_number)
          WHEN Department_number / 10 >= 10 AND Department_number / 10 < 100 THEN CAST(Department_number AS STRING)
          ELSE CAST(Department_number AS STRING)
        END AS Department_number_3digits,
        CASE
          WHEN Department_number / 10 < 1 THEN CONCAT('0', Department_number)
          WHEN Department_number / 10 >= 1 AND Department_number / 10 < 10 THEN CAST(Department_number AS STRING)
          ELSE CAST(Department_number AS STRING)
        END AS Department_number_2digits,
        SPLIT(Department_Description, '. ')[1] AS Department_Description
      FROM metro-bi-wb-inventory-s00.customization.departments_new 
    )
  ),

  rows_generated AS (
    SELECT * FROM metro-bi-wb-inventory-s00.Country_dashboards.bbd_operational1_${c.iso2}
    WHERE Date >= DATE('2025-01-01') -- year change
  ),

  rows_generated_aux AS (
    SELECT DISTINCT * FROM (
    SELECT * EXCEPT (status, isRemoved, isNotFound, isChecked, bbdSource, creationUser2), status, isRemoved, isNotFound, isChecked, bbdSource, creationUser2 FROM rows_generated
    WHERE dateWhenFirstlyNeededToBeRemoved = Date

    UNION ALL
    SELECT * EXCEPT (status, isRemoved, isNotFound, isChecked, bbdSource, creationUser2), status, isRemoved, isNotFound, isChecked, bbdSource, creationUser2 FROM rows_generated
    WHERE
      -- (changeDateBC IS NOT NULL AND dateWhenFirstlyNeededToBeRemoved != DATE(TIMESTAMP(changeDateBC)))
      (changeDateBC IS NOT NULL AND dateWhenFirstlyNeededToBeRemoved != Date)
      OR (changeDateBC IS NULL)
    )
  ),

  rows_generated_with_result AS (
    -- SELECT DISTINCT * EXCEPT (timestampWhenActioned, changeDateBC) FROM (
      SELECT * FROM (
      SELECT
        *,
        CASE
          WHEN isRemoved = true AND (NOT (status = 'DONE' AND quantity > 0)) THEN 'bbd_checked_added_to_cart'
          WHEN isNotFound = true AND (NOT (status = 'DONE' AND quantity > 0)) 
            AND (creationUser2 IS NULL OR creationUser2 != 'BBDStockZero') THEN 'bbd_checked_not_found'
          WHEN isChecked = false THEN 'bbd_to_be_checked'
          WHEN (status = 'DONE' AND quantity > 0 AND DATE(changeDateBC) > DATE(bestBeforeDate) AND checkUser IS NULL)
            OR checkUser = 'placeholder_for_future_to_be_filled' THEN 'bbd_expired_without_action'
          -- WHEN status = 'DONE' AND quantity > 0 AND creationUser2 = 'BBDStockZero' THEN 'bbd_zero_stock_'
          WHEN status = 'DONE' AND quantity > 0 AND NOT(DATE(changeDateBC) > DATE(bestBeforeDate) AND checkUser IS NULL) THEN 'bbd_actioned'
          -- status DONE, quantity > 0, changeDate (in bc) > bestBeforeDate si checkUser NULL 
        END AS result
      FROM rows_generated_aux
      WHERE NOT (
                  creationUserBC = 'BBDStockZero'
                  AND lastChangeDateWhenBBDStockZeroANDdeleted IS NOT NULL
                  AND Date = DATE(lastChangeDateWhenBBDStockZeroANDdeleted)
                )
      -- WHERE Date = CURRENT_DATE('Europe/Bucharest')-1
    )
  ),

  ---------- REMOVE AND ACTIONED:

  system_stock_removed_actions AS (
    SELECT
      country, locationID, articleNo, bundleNo, variant, dataGroup, totalQuantity AS systStock, processingTimestamp
      -- , rn as rn2
    FROM (
      SELECT
        country, locationID, articleNo, bundleNo, variant, dataGroup, totalQuantity,
        TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(processingTimestamp), 'Europe/Amsterdam')) AS processingTimestamp,
      FROM \`${projectFor(c.internal)}.ingest_movie.stock_events\` stock
      WHERE
        PARTITIONTIME >= TIMESTAMP('2024-07-01')
        AND datagroup = 'SYST'
        -- AND locationId NOT IN (83,84,85,86)
    ) s
    -- WHERE
    --   s.rn = 1
  ),

  markdown_stock_removed_actions AS (
    SELECT
      country, locationID, articleNo, bundleNo, variant, dataGroup, totalQuantity AS madoStock, processingTimestamp
    FROM (
      SELECT
        country, locationID, articleNo, bundleNo, variant, dataGroup, totalQuantity,
        TIMESTAMP(FORMAT_TIMESTAMP("%F %T", TIMESTAMP(processingTimestamp), 'Europe/Amsterdam')) AS processingTimestamp,
      FROM \`${projectFor(c.internal)}.ingest_movie.stock_events\` stock
      WHERE
        PARTITIONTIME >= TIMESTAMP('2024-07-01')
        AND datagroup = 'MADO'
        -- AND locationId NOT IN (83,84,85,86)
    ) s
    -- WHERE
    --   s.rn = 1
  ),

  bl_joined_bc_joined_bmr_bul_aux_syst1_removed_actions AS (
    SELECT
      b.countryCode, b.salesLine, b.storeNumber,
      b.departmentNumber, b.mainMerchandiseGroup, b.merchandiseGroup, b.merchandiseSubgroup,
      b.Date,
      b.bbdRuleId, b.bbdCheckId, b.id, b.quantity,
      b.articleNumber, b.bundleNumber, b.variantNumber, b.subsystemArticleNumber, b.lotNumber,
      ss.systStock,
      b.bestBeforeDate,
      b.gracePeriod,
      b.dateEnteringGracePeriod, b.dateWhenFirstlyNeededToBeRemoved,
      b.isChecked, b.isNotFound, b.isRemoved,
      b.isBbdDue,
      b.shouldBeChecked,
      b.result,
      b.status,
      ss.processingTimestamp AS systStockDate,
      b.changeDateBL, b.changeDateBC,
      b.creationDateBL, b.creationUserBL, b.creationUserBC,
      b.creationUser2,
      b.logicallyDeleted, b.bbdSource
    FROM rows_generated_with_result b
    LEFT JOIN system_stock_removed_actions ss ON
      b.articleNumber = ss.articleNo
      AND b.bundleNumber = ss.bundleNo
      AND b.variantNumber = ss.variant
      AND COALESCE( -- !!!
        TIMESTAMP(changeDateBC), 
        GREATEST(
          TIMESTAMP(CONCAT(CAST(dateWhenFirstlyNeededToBeRemoved AS STRING), ' 00:00:00.000001'), 'Europe/Bucharest'), 
          TIMESTAMP(CONCAT(CAST(Date AS STRING), ' 00:00:00.000001'), 'Europe/Bucharest')
        )



      ) >= TIMESTAMP(ss.processingTimestamp)
      AND b.storeNumber = ss.locationId
  ),

  bl_joined_bc_joined_bmr_bul_aux_syst2_removed_actions AS (
    SELECT *
    FROM (
      SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, bestBeforeDate, id, Date, status ORDER BY systStockDate DESC) AS rn
      FROM bl_joined_bc_joined_bmr_bul_aux_syst1_removed_actions
    )
    WHERE rn = 1
  ),

  bl_joined_bc_joined_bmr_bul_aux_mado1_removed_actions AS (
    SELECT 
      b.countryCode, b.salesLine, b.storeNumber,
      b.departmentNumber, b.mainMerchandiseGroup, b.merchandiseGroup, b.merchandiseSubgroup,
      b.Date,
      b.bbdRuleId, b.bbdCheckId, b.id, b.quantity,
      b.articleNumber, b.bundleNumber, b.variantNumber, b.subsystemArticleNumber, b.lotNumber,
      b.systStock,
      ms.madoStock,
      COALESCE(b.systStock - ms.madoStock, b.systStock) AS availableStock,
      b.bestBeforeDate,
      b.gracePeriod,
      b.dateEnteringGracePeriod, b.dateWhenFirstlyNeededToBeRemoved,
      b.isChecked, b.isNotFound, b.isRemoved,
      b.isBbdDue,
      b.shouldBeChecked,
      b.result,
      b.status,
      b.systStockDate, ms.processingTimestamp AS madoStockDate,
      b.changeDateBL, b.changeDateBC,
      b.creationDateBL, b.creationUserBL, b.creationUserBC,
      b.creationUser2,
      b.logicallyDeleted, b.bbdSource
    FROM bl_joined_bc_joined_bmr_bul_aux_syst2_removed_actions b
    LEFT JOIN markdown_stock_removed_actions ms ON
      b.articleNumber = ms.articleNo
      AND b.bundleNumber = ms.bundleNo
      AND b.variantNumber = ms.variant
      AND COALESCE( -- !!!
        TIMESTAMP(changeDateBC), 
        GREATEST(
          TIMESTAMP(CONCAT(CAST(dateWhenFirstlyNeededToBeRemoved AS STRING), ' 00:00:00.000001'), 'Europe/Bucharest'), 
          TIMESTAMP(CONCAT(CAST(Date AS STRING), ' 00:00:00.000001'), 'Europe/Bucharest') 
        )
      ) >= TIMESTAMP(ms.processingTimestamp)
      AND b.storeNumber = ms.locationId
  ),

  bl_joined_bc_joined_bmr_bul_aux_mado2_removed_actions AS (
    SELECT * EXCEPT (rn) FROM (
      SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY storeNumber, articleNumber, variantNumber, bundleNumber, bestBeforeDate, id, Date, status ORDER BY madoStockDate DESC) AS rn
      FROM bl_joined_bc_joined_bmr_bul_aux_mado1_removed_actions
    )
    WHERE rn = 1
  ),

  final_removed_actions AS (
    SELECT * EXCEPT (articleRemovedNotFound, articleRemovedAddedToCart, articleToBeRemoved),
      CASE WHEN articleActioned = 1 OR articleExpiredWithoutAction = 1 THEN 0 ELSE articleRemovedNotFound END AS articleRemovedNotFound,
      CASE WHEN articleActioned = 1 OR articleExpiredWithoutAction = 1 THEN 0 ELSE articleRemovedAddedToCart END AS articleRemovedAddedToCart,
      CASE WHEN articleActioned = 1 OR articleExpiredWithoutAction = 1 THEN 0 ELSE articleToBeRemoved END AS articleToBeRemoved
    FROM (
      SELECT
        CASE
          WHEN bm.result = 'bbd_actioned' THEN 1
          ELSE 0
        END AS articleActioned,
        CASE
          WHEN bm.result = 'bbd_expired_without_action' THEN 1
          ELSE 0
        END AS articleExpiredWithoutAction,
        CASE
          WHEN
          -- bm.shouldBeChecked = true AND
          isNotFound = true THEN 1
          -- result = 'bbd_checked_not_found' THEN 1
          ELSE 0
        END AS articleRemovedNotFound,
        CASE
          WHEN
          -- bm.shouldBeChecked = true AND
          isRemoved = true THEN 1
          ELSE 0
        END AS articleRemovedAddedToCart,
        CASE
          WHEN
          -- bm.shouldBeChecked = true AND
          -- bm.isBbdDue = false AND
          bm.isChecked = false 
          -- AND bm.availableStock > 0.1
          THEN 1
            --AND bm.logicallyDeleted = false
          ELSE 0
        END AS articleToBeRemoved,
        CASE
          WHEN bm.creationUser2 = 'BBDExpired' THEN 1
          ELSE 0
        END AS userBbdExpired,
        CASE
          WHEN bm.creationUser2 NOT IN ('BBDExpired', 'User') AND bm.creationUser2 IS NOT NULL THEN 1
          ELSE 0
        END AS userOtherBbdReasons,
        a.art_name,
        bm.*
      FROM bl_joined_bc_joined_bmr_bul_aux_mado2_removed_actions bm
      LEFT JOIN \`${projectFor(c.internal)}.cc_dwh.dw_article\` a ON
        bm.articleNumber = a.art_no
      WHERE
        -- (bm.result = 'bbd_actioned') OR (bm.shouldBeChecked = true AND isNotFound) OR (bm.shouldBeChecked = true AND isRemoved)
        --   OR (bm.shouldBeChecked = true AND bm.isBbdDue = false AND bm.isChecked = false AND bm.availableStock > 0.1)
        -- aici:
        (bm.result = 'bbd_actioned') OR (isNotFound = true) OR (isRemoved = true)
        -- OR (bm.isBbdDue = false AND bm.isChecked = false AND bm.availableStock > 0.1)
        OR bm.isChecked = false
    )
  ),

  final2_removed_actions AS ( --!--
    SELECT * FROM (
      SELECT
        countryCode, storeNumber, salesLine, departmentNumber, mainMerchandiseGroup, merchandiseGroup, merchandiseSubgroup,
        id, bbdCheckId,
        articleNumber, bundleNumber, variantNumber, subsystemArticleNumber, lotNumber, art_name, bbdSource,
        quantity, systStock, madoStock, availableStock, 
        Date, gracePeriod, dateEnteringGracePeriod, bestBeforeDate,
        dateWhenFirstlyNeededToBeRemoved,
        result,
          CASE
            WHEN articleToBeRemoved = 1 THEN 'bbd_to_be_checked'
            WHEN articleRemovedNotFound = 1 AND articleActioned = 0 THEN 'bbd_checked_not_found'
            WHEN articleRemovedAddedToCart = 1 AND articleActioned = 0 THEN 'bbd_checked_removed_from_shelf'
            WHEN articleActioned = 1 THEN 'bbd_actioned'
            WHEN articleExpiredWithoutAction = 1 THEN 'bbd_expired_without_action'
          END                                                                             AS tool,
        status, 
        articleActioned, articleRemovedNotFound, articleRemovedAddedToCart, articleToBeRemoved,
        bbdRuleId, 
        creationDateBL, creationUserBL, 
        creationUserBC, creationUser2 AS creationUserTypeBC,
        userBbdExpired AS creationUserBbdExpiredBC, userOtherBbdReasons AS creationUserOtherReasonsBC, 
        changeDateBL, 
        changeDateBC AS changeDateBCtimestamp, 
        logicallyDeleted, 
        isChecked, 
        isNotFound, 
        isRemoved, 
        isBbdDue, 
        shouldBeChecked, 
        systStockDate, 
        madoStockDate,
        -- DATE_DIFF(COALESCE(DATE(TIMESTAMP(lastUpdatedDate)), CURRENT_DATE('Europe/Bucharest')-1), DATE(TIMESTAMP(creationDate)), day) + 1
        --   AS daysSincePublishedToListTillBbdAddedOrQueryRunDate,
        FROM final_removed_actions
    )
    WHERE
      NOT (Tool = 'bbd_to_be_checked' AND status = 'DONE' AND creationUserBC = 'BBDStockZero')
  ),

  ranked_bbd_check_results AS (
      SELECT * EXCEPT (rn) FROM (
        SELECT
          *,
          ROW_NUMBER() OVER (PARTITION BY storeNumber, bbdCheckId, actionName ORDER BY changeDate DESC, statusMapped DESC) AS rn
        FROM (
          SELECT
            *,
            CASE
              WHEN status = 'OPEN' THEN 1
              WHEN status = 'PROCESSING' THEN 2
              WHEN status IN ('ERROR', 'DONE') THEN 3
            END AS statusMapped,
          FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_check_results\`
          WHERE DATE(PARTITIONTIME) >= DATE('2025-01-01') -- year change
        )
      )
      WHERE rn = 1
  ),

  final3_removed_actions AS (
    SELECT
      bc.* EXCEPT (tool, quantity),
      -- CASE
      --   WHEN bcr.actionName IS NOT NULL THEN CONCAT(bc.tool, '_', bcr.actionName)
      --   ELSE CONCAT(bc.tool, '_', '<unknown>')
      -- END AS tool,
      CASE
        WHEN bc.articleActioned = 1 AND bcr.actionName IS NOT NULL AND bcr.status = 'DONE' THEN CONCAT(bc.tool, '_', bcr.actionName)
        WHEN bc.articleActioned = 1 AND bcr.actionName IS NULL THEN CONCAT(bc.tool, '_', '<unknown>')
        ELSE CONCAT(bc.tool, '_', '<unknown>')
      END AS tool,
      CASE
        WHEN bcr.quantity IS NOT NULL THEN bcr.quantity
        ELSE bc.quantity
      END AS quantity
    FROM final2_removed_actions bc
    LEFT JOIN ranked_bbd_check_results bcr ON
      bc.bbdCheckId = bcr.bbdCheckId
    WHERE
      bc.tool = 'bbd_actioned'
      AND (bcr.actionName IS NULL OR (NOT (bcr.actionName IS NOT NULL AND bcr.status != 'DONE')))
    UNION ALL
    SELECT * EXCEPT (tool, quantity), tool, quantity
    FROM final2_removed_actions
    WHERE tool != 'bbd_actioned'
  ),

  final4_removed_actions AS (
    -- SELECT *,
    --   MAX(toolOrder) OVER (PARTITION BY storeNumber, subsystemArticleNumber, bestBeforeDate) AS maxTool
    -- FROM (
      SELECT
        -- (case when Tool in ('bbd_missing', 'bbd_to_be_checked') then null else DATE_DIFF(Date, Creation_date, day) end)
        --   AS Days_to_execution_counter,
        case when gracePeriod = 0 then 1 else gracePeriod end as gracePeriodNonZero,
        CASE
          WHEN STARTS_WITH(Tool, 'bbd_actioned_') THEN 'bbd_actioned'
          WHEN STARTS_WITH(Tool, 'bbd_checked_') THEN 'bbd_checked'
          ELSE NULL
        END AS Tool_general,
          *
      FROM (
      SELECT
        -- MIN(Date) OVER (PARTITION BY storeNumber, articleNumber, bundleNumber, variantNumber,
        --   subsystemArticleNumber, bestBeforeDate, tool) AS Creation_date,
        -- MIN(Date) OVER (PARTITION BY storeNumber, id, tool) AS Creation_date,
        * FROM (
      SELECT
        CASE
          -- WHEN tool = 'bbd_missing' THEN 0
          -- WHEN tool = 'bbd_added' THEN 1
          WHEN tool = 'bbd_to_be_checked' THEN 2
          WHEN tool = 'bbd_checked_not_found' THEN 3
          WHEN tool = 'bbd_checked_removed_from_shelf' THEN 4
          WHEN tool LIKE '%bbd_actioned%' OR tool = 'bbd_expired_without_action' THEN 5
        END AS toolOrder,
        *
      FROM final3_removed_actions
    )
      )
  ),

  final5_removed_actions AS (
    SELECT
    *,
    CASE
    -- WHEN Tool = 'bbd_to_be_c' THEN initial_creation_date
    WHEN Tool = 'bbd_to_be_checked' THEN initial_creation_date
    WHEN Tool = 'bbd_checked_removed_from_shelf' THEN initial_creation_date
    WHEN Tool LIKE 'bbd_actioned_%' THEN checked_removed_from_shelf_date
    -- ELSE Creation_date,
  END AS Creation_date
  FROM (
    SELECT
      *, 
      MIN(Date) OVER (PARTITION BY countryCode, storeNumber, id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS initial_creation_date,
      MIN(CASE WHEN Tool = 'bbd_checked_removed_from_shelf' THEN Date END) OVER (PARTITION BY countryCode, storeNumber, id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS checked_removed_from_shelf_date
    FROM final4_removed_actions
  )
  ),

  final6_removed_actions AS (
    SELECT *,
    (case when Tool in ('bbd_missing', 'bbd_to_be_checked') then null else DATE_DIFF(Date, Creation_date, day) end)
          AS Days_to_execution_counter
    FROM final5_removed_actions
    -- WHERE
    --   NOT (Tool = 'bbd_to_be_checked' AND DATE(Date) = DATE(dateWhenFirstlyNeededToBeRemoved) AND creationUserBC = 'BBDStockZero')

  ),

  removed_and_actions AS (
    SELECT
      a.*,
      b.department_description AS Department_name,
      CASE
        WHEN LENGTH(CAST(a.Store_no AS STRING)) = 1 THEN CONCAT('0', a.Store_no, '. ', c.store_desc)
        ELSE CONCAT(a.Store_no, '. ', c.store_desc)
      END                                                                               AS Store_name,
      NULL AS systStockLatestOnTheDay,
      TIMESTAMP('1970-01-01 00:00:00') AS systStockDateLatestOnTheDay, -- to be added
      NULL AS madoStockLatestOnTheDay,
      TIMESTAMP('1970-01-01 00:00:00') AS madoStockDateLatestOnTheDay, -- to be added
      NULL AS availableStockLatestOnTheDay,
    FROM (
      SELECT
        countryCode || storeNumber || id || Date || tool AS PK,
        countryCode || storeNumber || id AS PK2,
        countryCode || storeNumber || articleNumber || bundleNumber || variantNumber || subsystemArticleNumber AS PK3,
        countryCode || storeNumber || id || Date || Tool_general AS PK4special,
        countryCode || storeNumber || id  AS PK5notactioned,
        id,
        NULL AS Is_added_directly,
        countryCode                                                                     AS Country,
        Date,
        TIMESTAMP(changeDateBCtimestamp)                                                AS Timestamp_task_completion,
        -- dateWhenFirstlyNeededToBeRemoved                                                AS Creation_date,
        Creation_date                                                                   AS Creation_date,
        '1970-01-01 00:00:00'                                                           AS Change_date,
        bestBeforeDate                                                                  AS Best_before_date,
        bestBeforeDate                                                                  AS Best_before_date_retro, -- 14
        storeNumber                                                                     AS Store_no,
        departmentNumber                                                                AS Department_no,
        'ingest_inventory, ingest_movie'                                                AS Data_source,
        tool                                                                            AS Tool,
        Tool_general                                                                    AS Tool_general,
        bbdSource                                                                       AS Bbd_source,
        creationUserBC                                                                  AS Creation_user,
        CASE
          WHEN creationUserTypeBC LIKE '%@%' OR creationUserTypeBC LIKE '% %' THEN 'User'
          ELSE creationUserTypeBC
        END                                                                             AS User_type,
        NULL                                                                            AS Day_usage_counter_ADDED, --23
        CASE
          WHEN articleRemovedNotFound = 1 OR articleRemovedAddedToCart = 1 THEN 0
          WHEN articleActioned = 1 THEN NULL
          ELSE 1
        END                                                                             AS Day_usage_counter_REMOVED,
        CASE
          WHEN articleActioned = 1 THEN 0
          WHEN articleRemovedNotFound = 1 OR articleRemovedAddedToCart = 1 THEN 1
          ELSE NULL
        END                                                                             AS Day_usage_counter_ACTIONED,
        DATE_DIFF(DATE(bestBeforeDate), Date, day)                                      AS Day_expiry_counter,
        Days_to_execution_counter                                                       AS Days_to_execution_counter,
        case
          when Days_to_execution_Counter>gracePeriod AND (creationUserBC IS NULL OR creationUserBC != 'BBDStockZero') then "Expired-no action"
          when Days_to_execution_Counter>gracePeriod AND (creationUserBC = 'BBDStockZero') then "Zero stock-no action"
          when Days_to_execution_Counter/gracePeriodNonZero<=0.33 then 'Fast actioned'
          when Days_to_execution_Counter/gracePeriodNonZero>0.66 then 'Slow actioned'
          when Days_to_execution_Counter/gracePeriodNonZero > 0.33 AND Days_to_execution_Counter/gracePeriodNonZero <= 0.66 THEN 'Medium actioned'
          WHEN Days_to_execution_Counter IS NULL THEN 'Not yet actioned' end                                                      AS Reaction_time,
        art_name                                                                        AS Article_name,
        (articleNumber * 1000000) + (variantNumber * 1000) + bundleNumber               AS Article_id,
        subsystemArticleNumber                                                          AS Article_no,
        quantity                                                                        AS Quantity_manipulated,
        availableStock                                                                  AS Available_Stock,
        systStock                                                                       AS Syst_stock,
        madoStock                                                                       AS Mado_stock,
        gracePeriod                                                                     AS Grace_period,
        lotNumber                                                                       AS Lot_number,
        mainMerchandiseGroup                                                            AS PMMG,
        merchandiseGroup                                                                AS PMG,
        merchandiseSubgroup                                                             AS PMsG,
        toolOrder, --, maxTool --41
        bbdRuleId
      FROM final6_removed_actions
      WHERE Date >= Date('2023-01-01')
      AND Date <= CURRENT_DATE('Europe/Bucharest')-1
      -- AND storeNumber NOT IN (83,84,85,86)
    ) a
    LEFT JOIN departments b ON a.Country = b.country AND a.Department_no = b.Department_number
    LEFT JOIN (
      SELECT DISTINCT
        countrycode,
        store_no,
        store_desc
      FROM metro-bi-wb-inventory-s00.customization.labels1
    ) c ON a.Country = c.countrycode AND a.Store_no = c.store_no
  )
  ,

  a AS (
    SELECT
      CASE
        WHEN Tool = 'bbd_missing' THEN 1
        WHEN Tool = 'bbd_added' THEN 2
        WHEN Tool = 'bbd_to_be_checked' THEN 3
        WHEN Tool = 'bbd_checked_removed_from_shelf' OR Tool = 'bbd_checked_not_found' THEN 4
        WHEN Tool LIKE 'bbd_actioned_%' THEN 5
      END AS Tool_numbered,
      *
    FROM (
      SELECT
        * EXCEPT (Quantity_in_actions, articleNumber, variantNumber, bundleNumber, hasBbdNew, 
          isAddedOnMissingDate, systStockLatestOnTheDay, systStockDateLatestOnTheDay,
          madoStockLatestOnTheDay, madoStockDateLatestOnTheDay, availableStockLatestOnTheDay, Creation_timestamp),
        systStockLatestOnTheDay, systStockDateLatestOnTheDay, madoStockLatestOnTheDay, madoStockDateLatestOnTheDay,
        availableStockLatestOnTheDay, Quantity_in_actions, Creation_timestamp, NULL AS bbdRuleId
      FROM missing
      UNION ALL
      SELECT * EXCEPT (bbdRuleId), NULL AS Quantity_in_actions, NULL AS Creation_timestamp, bbdRuleId FROM removed_and_actions
    )
  ),

    aa AS (
    SELECT
      EXTRACT(year FROM Date) * 10000 + EXTRACT(month FROM Date) * 100 + EXTRACT(day FROM Date) AS Date_numbered,
      CAST(CONCAT(CAST(EXTRACT(year FROM Date) * 10000 + EXTRACT(month FROM Date) * 100 + EXTRACT(day FROM Date) AS STRING), CAST(Tool_numbered AS STRING)) AS INT64) AS Date_Tool_numbered,
      *
    FROM a
  ),

  x AS (
    SELECT
      *,
      CASE
        WHEN Tool IN ('bbd_missing', 'bbd_added') THEN 'missing'
        WHEN Tool IN ('bbd_to_be_checked', 'bbd_checked_not_found', 'bbd_checked_removed_from_shelf') OR Tool LIKE 'bbd_actioned_%' THEN 'checked'
      END AS Tool_categ,
    FROM aa
  ),

  y as (
      SELECT
        LAG(Tool) OVER (PARTITION BY Store_no, Article_no, Best_before_date, Creation_date, id ORDER BY Date_Tool_numbered ASC) AS Previous_tool,
        *
      FROM x
  ),

  z AS (
    SELECT
      CASE
        WHEN Tool = Previous_tool THEN 0
        WHEN Previous_tool IS NULL THEN 1
        ELSE 1
      END AS Change,
      *
    FROM y
  ),

  b1 as (
    SELECT
      COALESCE(SUM(Change) OVER (PARTITION BY Store_no, Article_no, Best_before_date, Creation_date ORDER BY Date_Tool_numbered ASC RANGE BETWEEN UNBOUNDED PRECEDING AND 0 following), 0) AS Summ,
      *
    FROM z
  ),

  bb AS (
    SELECT
      CASE
        WHEN Change = 0 AND Tool NOT IN ('bbd_missing', 'bbd_added') THEN CONCAT(Tool, '_pending')
        WHEN Previous_tool IS NULL THEN Tool
        WHEN Tool LIKE 'bbd_actioned_%'
          -- OR Tool = 'bbd_added'
          THEN Tool
        ELSE Tool
      END AS Tool_new,
      *
    FROM b1
  ),

  bbc AS (
    SELECT
      * EXCEPT (Tool_new),
      CASE WHEN Tool = 'bbd_added' THEN Tool ELSE Tool_new END AS Tool_new
    FROM bb
  ),

  bbb AS (
    SELECT
      * EXCEPT (Reaction_time),
      CASE WHEN ENDS_WITH(Tool_new, '_pending') THEN NULL ELSE Reaction_time END AS Reaction_time
    FROM bbc
  ),

  bbd_operational AS (
    SELECT
      PK,
      PK2,
      PK3,
      PK4special,
      PK5notactioned,
      id,
      Is_added_directly,
      Country,
      Date,
      Timestamp_task_completion,
      Date_Tool_numbered,
      Creation_date,
      Creation_timestamp,
      Change_date,
      Best_before_date,
      Best_before_date_retro,
      Store_no,
      Department_no,
      Data_source,
      Tool,
      Tool_new,
      Tool_categ,
      Bbd_source,
      Creation_user,
      User_type,
      Day_usage_counter_ADDED,
      Day_usage_counter_REMOVED,
      Day_usage_counter_ACTIONED,
      Day_expiry_counter,
      Days_to_execution_counter,
      Reaction_time,
      Article_name,
      Article_id,
      Article_no,
      Quantity_manipulated,
      Quantity_in_actions,
      Available_Stock,
      Syst_stock,
      Mado_stock,
      systStockLatestOnTheDay AS Syst_stock_end_of_day,
      madoStockLatestOnTheDay AS Mado_stock_end_of_day,
      systStockLatestOnTheDay - madoStockLatestOnTheDay AS Available_stock_end_of_day,
      Grace_period,
      Lot_number,
      PMMG,
      PMG,
      PMsG,
      toolOrder AS Tool_order,
      Department_name,
      Store_name,
      bbdRuleId
    FROM bbb
  ),

  bbd_operational2 AS (
    SELECT
      LAST_VALUE(Tool_order) OVER (PARTITION BY CONCAT(PK5notactioned, Date), Tool_categ
      -- LAST_VALUE(Tool_order) OVER (PARTITION BY CONCAT(PK4special, Date), Tool_categ
        ORDER BY Date_Tool_numbered ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS Last_tool_numbered,
      *
    FROM bbd_operational
    WHERE Tool_categ = 'checked'
    UNION ALL
    SELECT
      -- LAST_VALUE(Tool_order) OVER (PARTITION BY CONCAT(PK5notactioned, Date), Tool_categ
      LAST_VALUE(Tool_order) OVER (PARTITION BY CONCAT(PK4special, Date), Tool_categ
        ORDER BY Date_Tool_numbered ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS Last_tool_numbered,
      *
    FROM bbd_operational
    WHERE Tool_categ = 'missing'
  ),

  state_added AS (
    SELECT
      CASE
        -- WHEN Tool IN ('bbd_missing', 'bbd_to_be_checked') AND Tool_order = Last_tool_numbered THEN 0
        -- WHEN Tool IN ('bbd_missing', 'bbd_to_be_checked') AND Last_tool_numbered > Tool_order THEN 1
        WHEN Tool IN ('bbd_missing', 'bbd_to_be_checked') AND Tool_order = Last_tool_numbered THEN 'to_be_done'
        WHEN Tool = 'bbd_missing' AND Last_tool_numbered = 1 THEN 'bbd_added'
        WHEN Tool = 'bbd_to_be_checked' AND Last_tool_numbered = 3 THEN 'bbd_checked_not_found'
        WHEN Tool = 'bbd_to_be_checked' AND Last_tool_numbered = 4 THEN 'bbd_checked_removed_from_shelf'
        WHEN Tool = 'bbd_to_be_checked' AND Last_tool_numbered = 5 THEN 'bbd_actioned'
      END AS state_of_to_be_added_and_to_be_checked, -- AS is_actioned 0 or 1
      CASE
        WHEN Tool = 'bbd_checked_not_found' THEN 'bbd_checked_not_found'
        WHEN Tool = 'bbd_checked_removed_from_shelf' AND Last_tool_numbered = 5 THEN 'bbd_removed_and_actioned'
        WHEN Tool = 'bbd_checked_removed_from_shelf' AND Last_tool_numbered = 4 THEN 'bbd_removed_and_not_actioned'
      END AS state_of_checked,
      *
    FROM bbd_operational2
  ),

  curent_state_aux_added AS (
    SELECT
      CASE
        WHEN Tool = 'bbd_missing' AND state_of_to_be_added_and_to_be_checked = 'to_be_done' THEN 'to_be_added' -- o sa se repete linii
        WHEN Tool = 'bbd_added' OR (Tool = 'bbd_missing' AND state_of_to_be_added_and_to_be_checked = 'bbd_added') THEN 'added'
        WHEN Tool = 'bbd_checked_not_found' OR (Tool = 'bbd_to_be_checked' AND state_of_to_be_added_and_to_be_checked = 'bbd_checked_not_found') THEN 'checked_not_found'
        WHEN Tool = 'bbd_to_be_checked' AND state_of_to_be_added_and_to_be_checked = 'to_be_done' AND (Creation_user IS NULL OR Creation_user != 'BBDExpired') THEN 'to_be_checked'
        WHEN Tool = 'bbd_to_be_checked' AND Creation_user = 'BBDExpired' THEN 'expired_without_checking' -----
        WHEN Tool = 'bbd_checked_removed_from_shelf' AND state_of_checked = 'bbd_removed_and_not_actioned' OR (Tool = 'bbd_to_be_checked' AND state_of_to_be_added_and_to_be_checked = 'bbd_checked_removed_from_shelf') THEN 'to_be_actioned' -----
        WHEN Tool LIKE 'bbd_actioned_%' OR (Tool = 'bbd_checked_removed_from_shelf' AND state_of_checked = 'bbd_removed_and_actioned') OR (Tool = 'bbd_to_be_checked' AND state_of_to_be_added_and_to_be_checked = 'bbd_actioned') THEN 'actioned'
        WHEN Tool = 'bbd_expired_without_action' THEN 'expired_without_action' ------
      END AS current_state_aux,
      *
    FROM state_added
  ),

  current_state_added AS (
    SELECT
      CASE
        WHEN Tool = 'bbd_to_be_checked' AND state_of_to_be_added_and_to_be_checked = 'to_be_done' AND latest_current_state IS NULL THEN 'to_be_checked'
        -- WHEN Tool = 'bbd_to_be_checked' AND state_of_to_be_added_and_to_be_checked = 'to_be_done' AND latest_current_state IS NOT NULL THEN 'expired_without_checking'
        ELSE current_state_aux
      END AS current_state,
      *
    FROM (
      SELECT
        MAX(current_state_aux) OVER (PARTITION BY Store_no, id, Tool, state_of_to_be_added_and_to_be_checked) AS latest_current_state,
        *
      FROM curent_state_aux_added
    )
  ),

-- SELECT * FROM current_state_added

  y2 as (
      SELECT
        LAG(current_state) OVER (PARTITION BY Store_no, Article_no, Best_before_date, Creation_date ORDER BY Date_Tool_numbered ASC) AS Previous_current_state,
        *
      FROM current_state_added
  ),

  z2 AS (
    SELECT
      CASE
        WHEN current_state = Previous_current_state THEN 0
        WHEN Previous_current_state IS NULL THEN 1
        ELSE 1
      END AS Change,
      *
    FROM y2
  ),

  b12 as (
    SELECT
      COALESCE(SUM(Change) OVER (PARTITION BY Store_no, Article_no, Best_before_date, Creation_date ORDER BY Date_Tool_numbered ASC RANGE BETWEEN UNBOUNDED PRECEDING AND 0 following), 0) AS Summ,
      *
    FROM z2
  ),

  bb2 AS (
    SELECT
      CASE WHEN Change = 0 AND current_state NOT IN ('actioned', 'added', 'checked_not_found') THEN CONCAT(current_state, '_pending')
      WHEN Previous_current_state IS NULL THEN current_state
      WHEN current_state = 'actioned' OR current_state = 'added' OR current_state = 'checked_not_found' THEN current_state
      ELSE current_state END AS current_state_new, * FROM b12
  ),

  bbc2 AS (
    SELECT
      * EXCEPT (current_state_new),
      CASE WHEN current_state IN ('actioned', 'added', 'checked_not_found') THEN current_state ELSE current_state_new END AS current_state_new
    FROM bb2
  ),

  op AS (

SELECT
  * EXCEPT (Creation_user),
  CASE
    WHEN Tool = 'bbd_expired_without_action' THEN 'BBDExpired'
    WHEN Creation_user IN ('scheduler_missing_bbd', 'missing_bbd_job') THEN 'scheduler_missing_bbd'
    ELSE Creation_user END AS Creation_user
FROM (
  SELECT
    CASE WHEN (Tool = 'bbd_to_be_checked' AND Day_expiry_counter < 0 AND (Previous_current_state IS NULL OR Previous_current_state != 'to_be_actioned')) OR (Tool = 'bbd_checked_removed_from_shelf' AND Day_expiry_counter < (-2)) THEN false ELSE true END AS to_include,
    *
  FROM bbc2
)
  ),

  operational_non_missing AS (
    SELECT * FROM op
    WHERE Tool IS NULL OR Tool != 'bbd_missing'
  ),

  operational_missing AS (
    SELECT * FROM op
    WHERE
      Tool = 'bbd_missing'
  ),

  bl AS (
    SELECT * EXCEPT (rn) FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY storeNumber, id ORDER BY changeDate DESC) AS rn
      FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\`
      WHERE DATE(PARTITIONTIME) >= DATE('2025-01-01') -- year change
    )
    WHERE rn = 1
  ),

  bc AS (
    SELECT * EXCEPT (rn) FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY storeNumber, bbdCheckId ORDER BY changeDate DESC) AS rn
      FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_checked\`
      WHERE DATE(PARTITIONTIME) >= DATE('2025-01-01') -- year change
    )
    WHERE rn = 1
  ),

  bcr AS (
    SELECT
      storeNumber, bbdCheckId, SUM(quantity) AS quantity
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_check_results\`
    WHERE DATE(PARTITIONTIME) >= DATE('2025-01-01') -- year change
      AND status = 'DONE'
    GROUP BY 1, 2
  ),

  aux AS (
    SELECT bl.id, bl.bbdSource, bl.logicallyDeleted, bcr.quantity AS Quantity_actioned_total, bl.bestBeforeDate AS Best_before_date_new,
    bc.quantity AS quantityBC, bc.status,
    operational.Available_stock, operational.* EXCEPT (Available_stock, id)
    FROM operational_missing operational
    LEFT JOIN bl ON
      operational.Store_no = bl.storeNumber
      AND operational.Article_no = bl.subsystemArticleNumber
      AND DATE(operational.Date) = DATE(bl.changeDate)
      -- AND operational.Change_date <= bl.changeDate
    LEFT JOIN bc ON
      bl.storeNumber = bc.storeNumber
      AND bl.id = bc.bbdCheckId
    LEFT JOIN bcr ON
      bl.storeNumber = bcr.storeNumber
      AND bl.id = bcr.bbdCheckId
  ),

  op2 AS (
    -- blocul de mai jos l-am pus ca credeam eu ca NO inseamna de fapt si YES uneori
    -- SELECT 1 AS cv, 'bbd_added' AS Tool, Best_before_date_new AS Best_before_date, id,
    -- * EXCEPT (Tool, Best_before_date, id, Best_before_date_new, Quantity_actioned_total, bbdSource, logicallyDeleted, quantityBC, status) FROM aux
    -- WHERE
    --   ((Quantity_actioned_total IS NULL AND bbdSource NOT IN ('MARKDOWN', 'MMSSTORE', 'MMSSTORE_INITIAL_LOAD') AND logicallyDeleted = true)
    --   OR (Quantity_actioned_total IS NOT NULL AND ROUND(Quantity_actioned_total, 2) = ROUND(Syst_stock, 2)))
    --   AND (quantityBC IS NULL OR NOT (quantityBC = 0 AND status = 'DONE'))
    -- UNION ALL

    SELECT 2 AS cv, 'bbd_missing' AS Tool, Best_before_date, id,
    * EXCEPT (Tool, Best_before_date, id, Best_before_date_new, Quantity_actioned_total, bbdSource, logicallyDeleted, quantityBC, status) FROM aux
    WHERE
      ((Quantity_actioned_total IS NULL AND bbdSource NOT IN ('MARKDOWN', 'MMSSTORE', 'MMSSTORE_INITIAL_LOAD') AND logicallyDeleted = true)
      OR (Quantity_actioned_total IS NOT NULL AND ROUND(Quantity_actioned_total, 2) = ROUND(Syst_stock, 2)))
      AND (quantityBC IS NULL OR NOT (quantityBC = 0 AND status = 'DONE'))
    UNION ALL

    SELECT 3 AS cv, Tool, Best_before_date, id,
    * EXCEPT (Tool, Best_before_date, id, Best_before_date_new, Quantity_actioned_total, bbdSource, logicallyDeleted, quantityBC, status) FROM aux
    WHERE
      ((Quantity_actioned_total IS NULL AND bbdSource NOT IN ('MARKDOWN', 'MMSSTORE', 'MMSSTORE_INITIAL_LOAD') AND logicallyDeleted = false)
      OR (bbdSource != 'MARKDOWN' AND Quantity_actioned_total IS NOT NULL AND ROUND(Quantity_actioned_total, 2) != ROUND(Syst_stock, 2)))

      OR
      
      (
        -- (bbdSource IS NULL OR bbdSource != 'MARKDOWN')
      -- AND 
      (quantityBC = 0 AND status = 'DONE'))

      OR

      (bbdSource IS NULL OR bbdSource NOT IN ('MARKDOWN', 'MMSSTORE', 'MMSSTORE_INITIAL_LOAD'))
    UNION ALL

    SELECT 4 AS cv, Tool, Best_before_date, id, Available_stock, * EXCEPT (Tool, Best_before_date, id, Available_stock) FROM operational_non_missing
  ),
  
  op2_final AS (
    SELECT DISTINCT * EXCEPT (Summ, Change, Previous_current_state, current_state_new)
    FROM (
      -- SELECT
      --   Syst_stock, Tool,
      --   CASE WHEN Tool = 'bbd_to_be_checked' AND Creation_user = 'BBDStockZero' THEN NULL
      --   ELSE Creation_user END AS Creation_user,
      --   CASE WHEN Tool = 'bbd_to_be_checked' AND User_type = 'BBDStockZero' THEN NULL
      --   ELSE User_type END AS User_type,
      --   * except (Syst_stock, Tool, to_include, Creation_user, User_type)
      SELECT Syst_stock, Tool,
        Syst_stock_end_of_day, Mado_stock_end_of_day, Available_stock_end_of_day,
        Summ, Change, Previous_current_state, current_state, latest_current_state,
        current_state_aux, state_of_to_be_added_and_to_be_checked, state_of_checked,
        Last_tool_numbered, PK, PK2, PK3, PK4special, PK5notactioned, id, Is_added_directly,
        Country, Date, Timestamp_task_completion, Date_Tool_numbered, Creation_date,
        Creation_timestamp, Change_date, Best_before_date, Best_before_date_retro, Store_no,
        Department_no, Data_source, Tool_new, Tool_categ, Bbd_source, 
        CASE WHEN Tool = 'bbd_to_be_checked' AND User_type = 'BBDStockZero' THEN NULL
        ELSE User_type END AS User_type,
        Day_usage_counter_ADDED, Day_usage_counter_REMOVED, Day_usage_counter_ACTIONED,
        Day_expiry_counter, Days_to_execution_counter, Reaction_time, Article_name,
        Article_id, Article_no, Quantity_manipulated, Quantity_in_actions, Available_Stock,
        Mado_stock, Grace_period, Lot_number, PMMG, PMG, PMsG, Tool_order,
        Department_name, Store_name, current_state_new, 
        CASE WHEN Tool = 'bbd_to_be_checked' AND Creation_user = 'BBDStockZero' THEN NULL
        ELSE Creation_user END AS Creation_user,
        countryCode, storeNumber, salesLine, status, timezone, startDate, endDate, bbdRuleId
      FROM (
        SELECT DISTINCT
          * EXCEPT(Syst_stock, Syst_stock2),
          CASE
            WHEN Tool = 'bbd_to_be_checked' AND (Syst_stock2 <= 0.1 AND Syst_stock <= 0.1) OR Syst_stock > 0.1 THEN Syst_stock
            WHEN Tool = 'bbd_to_be_checked' AND Syst_stock2 > 0.1 AND Syst_stock <= 0.1  THEN Syst_stock2
            ELSE Syst_stock
          END AS Syst_stock
        FROM (
          SELECT DISTINCT
            LAST_VALUE(Syst_stock) OVER (PARTITION BY Store_no, Article_no, Best_before_date, id, Date, Tool_categ, current_state
              ORDER BY Tool_order ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS Syst_stock2,
            *
          FROM op -- am schimbat din op2 2024-10-25
          WHERE Tool_categ = 'checked'
          UNION ALL
          SELECT DISTINCT NULL AS Syst_stock2, * FROM op
          WHERE Tool_categ IS NULL OR Tool_categ != 'checked'
        )
      ) op
    LEFT JOIN metro-bi-wb-inventory-s00.Country_dashboards.bbd_inactive_stores inactive ON
      op.Store_no = inactive.storeNumber
      AND op.Date BETWEEN inactive.startDate AND inactive.endDate
      AND inactive.countryCode = '${c.iso2}'
    WHERE
      inactive.startDate IS NULL
      AND to_include = true
      AND NOT (current_state = 'to_be_checked' AND Syst_stock <= 0.1) -- added instead of the commented above on 26.02.2025
      AND NOT (Tool = 'bbd_checked_removed_from_shelf' AND Tool_new = 'bbd_checked_removed_from_shelf_pending' AND Syst_stock <= 0)
      AND NOT (Tool = 'bbd_to_be_checked' AND Day_expiry_counter < -1) -- should be < 0 but there were some cases in which the logicallyDeleted = true was put 1-2 days after the best before date day -- was -2 initially, changed to -1 on 13.03.2025
      AND Date >= DATE('2025-01-01') -- year change
    )
  ),

  bl_rules AS (
    SELECT bll.storeNumber, id, bbdRuleId, DATE(MIN(bll.changeDate)) AS changeDate, bmrr.gracePeriod
    FROM \`${projectFor(c.internal)}.ingest_inventory.bbd_list\` bll
    INNER JOIN bbd_merchandise_rules_bul bmrr ON
    bmrr.ruleId = bll.bbdRuleId
    WHERE DATE(PARTITIONTIME) >= DATE('2025-01-01') -- year change
    GROUP BY ALL
  ),

  op_bl_rules AS (
    SELECT * EXCEPT (rn, Grace_period, bbdRuleId, bbdRuleId_new, gracePeriod_new), gracePeriod_new AS Grace_period
    FROM (
      SELECT
        op2.*,
        bl_rules.bbdRuleId AS bbdRuleId_new,
        bl_rules.gracePeriod AS gracePeriod_new,
        ROW_NUMBER() OVER (PARTITION BY Store_no, op2.id, Tool, Date ORDER BY bl_rules.changeDate DESC) AS rn
      FROM op2_final op2
      INNER JOIN bl_rules ON
        op2.id = bl_rules.id
        AND op2.Store_no = bl_rules.storeNumber
        AND bl_rules.changeDate <= op2.Date
      WHERE
        op2.Tool IS NULL OR op2.Tool NOT IN ('bbd_missing', 'bbd_added')
    )
    WHERE
      rn = 1
      AND DATE_DIFF(DATE(Best_before_date), Date, day) <= gracePeriod_new
  )

SELECT * FROM op_bl_rules
UNION ALL
SELECT * EXCEPT (Grace_period, bbdRuleId), Grace_period FROM op2_final WHERE Tool IS NULL OR Tool IN ('bbd_missing', 'bbd_added')
`;




module.exports = { projectFor, bbd_operational0_XX, bbd_operational1_XX, bbd_operational2_1_XX, bbd_operational2_XX};