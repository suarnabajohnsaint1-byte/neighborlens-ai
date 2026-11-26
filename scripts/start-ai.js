const { spawn } = require("node:child_process");
const path = require("node:path");

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
        ? path.resolve(environment, "Scripts", "python.exe")
        : path.resolve(environment, "bin", "python");

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

const child = spawn(python, args, { stdio: "inherit", env: process.env });

child.on("exit", code => {
    process.exit(code ?? 1);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
