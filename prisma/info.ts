import { prisma } from "../src/lib/prisma";
import { getSetupConfig } from "../src/models/setupConfig";


// const getInfo = async () => {
//     const config = await getSetupConfig();
//     console.log(JSON.stringify(config, null, 2));
// }
// getInfo()
//     .catch((e) => {
//         console.error(e);
//         process.exitCode = 1;
//     })
//     .finally(async () => {
//         await prisma.$disconnect();
//     });

const clearActiveTrades = async () => {
    return await Promise.all([
        prisma.userActivities.deleteMany({}),
        prisma.userPositions.deleteMany({}),
    ]);
}

clearActiveTrades()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(async () => {
        console.log("Active trades cleared");
        await prisma.$disconnect();
    });