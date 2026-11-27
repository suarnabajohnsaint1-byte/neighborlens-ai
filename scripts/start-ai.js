const path = require("node:path");

const root = path.resolve(__dirname, "..");
const faceDev = process.argv.includes("--face-dev");
const host = process.env.AI_HOST || "127.0.0.1";
if (faceDev && (
    process.env.NODE_ENV === "production" || process.env.VERCEL ||
    !["127.0.0.1", "localhost", "::1"].includes(host)
)) {
    console.error("--face-dev requires a loopback development server.");
    process.exit(1);
}

const environment = faceDev ? ".venv-yolo" : ".venv";
const python =
    process.platform === "win32"
        ? path.join(root, environment, "Scripts", "python.exe")
        : path.join(root, environment, "bin", "python");

const weights =
    process.env.AI_MODEL_WEIGHTS ||
    "models/production/best.pt";

const port = process.env.AI_PORT || "8000";
const confidence = process.env.AI_CONFIDENCE || "0.30";
const imgsz = process.env.AI_IMAGE_SIZE || "640";

const args = [
    "-m",
    "ai.inference.inference_api",
    "--weights",
    weights,
    "--host",
    host,
    "--port",
    port,
    "--confidence",
    confidence,
    "--imgsz",
    imgsz
];
if (process.env.AI_PORTRAIT_MODEL) args.push("--portrait-model", process.env.AI_PORTRAIT_MODEL);
if (process.env.AI_OBJECT_MODEL) args.push("--object-model", process.env.AI_OBJECT_MODEL);

module.exports = { root, python, damageArgs: args, damageHost: host, damagePort: Number(port) };

if (require.main === module) {
    require("./start-ai-services").launch({ damageOnly: true }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
