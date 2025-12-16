const { countries } = require("../includes/countries");
const { bbd_operational0_XX, bbd_operational1_XX, bbd_operational2_1_XX, bbd_operational2_XX /*, gin_operational_XX*/} = require("../includes/queries");

countries.forEach((c) => {
    publish(`bbd_operational0_${c.iso2}`, {
        type: "table", 
        schema: "Country_dashboards"
    }).query(bbd_operational0_XX(c));

    publish(`bbd_operational1_${c.iso2}`, {
        type: "table", 
        schema: "Country_dashboards",
        // ensure dependency on bbd_operational0_XX
        dependencies: [`bbd_operational0_${c.iso2}`],
        bigquery: {
            partitionBy: "Date",
            //requirePartitionFilter: true
        }
    }).query(bbd_operational1_XX(c));

        publish(`bbd_operational2_1_daily_${c.iso2}`, {
        type: "table", 
        schema: "Country_dashboards",
        bigquery: {
            partitionBy: "Date",
            //requirePartitionFilter: true
        }
    }).query(bbd_operational2_1_XX(c));

    publish(`bbd_operational2_daily_${c.iso2}`, {
        type: "table", 
        schema: "Country_dashboards",
        bigquery: {
            partitionBy: "Date",
            //requirePartitionFilter: true
        },
        // ensure dependency on bbd_operational1_XX and bbd_operational2_1_XX
        dependencies: [`bbd_operational1_${c.iso2}`, `bbd_operational2_1_daily_${c.iso2}`]
    }).query(bbd_operational2_XX(c));

    // publish(`gin_operational_${c.iso2}`, {
    //     type: "table", 
    //     schema: "Country_dashboards",
    //     bigquery: {
    //         partitionBy: "Date",
    //         //requirePartitionFilter: true
    //     }
    // }).query(gin_operational_XX(c));


});
