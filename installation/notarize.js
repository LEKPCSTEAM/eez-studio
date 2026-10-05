require("dotenv").config();
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;
    if (electronPlatformName !== "darwin") {
        return;
    }

    if (!process.env.APPLEID || !process.env.APPLEIDPASS) {
        console.log("Skipping notarization: APPLEID or APPLEIDPASS not set");
        return;
    }

    const appName = context.packager.appInfo.productFilename;

    console.log('Apple id: "' + process.env.APPLEID + '"');

    return await notarize({
        appBundleId: "eu.envox.eez-studio",
        appPath: `${appOutDir}/${appName}.app`,
        appleId: process.env.APPLEID,
        appleIdPassword: process.env.APPLEIDPASS,
        teamId: "TG2466LDSJ"
    });
};
