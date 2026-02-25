module.exports = async function (context, req) {

    context.log("Analyze function triggered");

    context.res = {
        status: 200,
        body: {
            message: "API شغالة بنجاح 🚀",
            timestamp: new Date().toISOString()
        }
    };

};
