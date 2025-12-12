const { countries } = require("../includes/countries");
const { bbd_operational0_XX, bbd_operational1_XX, bbd_operational2_1_XX, bbd_operational2_XX /*, bbd_usage*/} = require("../includes/queries");

// const t4name = (c) => `bbd_operational2_${c.iso2}`;

 

countries.forEach((c) => {
    publish(`bbd_operational0_${c.iso2}`, {
        type: "table", 
        schema: "temp_orchestration"
    }).query(bbd_operational0_XX(c));

    publish(`bbd_operational1_${c.iso2}`, {
        type: "table", 
        schema: "temp_orchestration",
        // ensure dependency on bbd_operational0_XX
        dependencies: [`bbd_operational0_${c.iso2}`],
        bigquery: {
            partitionBy: "Date",
            //requirePartitionFilter: true
        }
    }).query(bbd_operational1_XX(c));

        publish(`bbd_operational2_1_${c.iso2}`, {
        type: "table", 
        schema: "temp_orchestration",
        bigquery: {
            partitionBy: "Date",
            //requirePartitionFilter: true
        }
    }).query(bbd_operational2_1_XX(c));

    publish(`bbd_operational2_${c.iso2}`, {
        type: "table", 
        schema: "temp_orchestration",
        bigquery: {
            partitionBy: "Date",
            //requirePartitionFilter: true
        },
        // ensure dependency on bbd_operational1_XX and bbd_operational2_1_XX
        dependencies: [`bbd_operational1_${c.iso2}`, `bbd_operational2_1_${c.iso2}`]
    }).query(bbd_operational2_XX(c));


        
});

    // publish(`bbd_usage`, {
    //     type: "table",
    //     schema: "temp_orchestration",
    //     dependencies: countries.map((c) => t4name(c)),
    //     bigquery: {
    //         partitionBy: "Date",
    //         //requirePartitionFilter: true
    //     }
    // }).query(bbd_usage);
