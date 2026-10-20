#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("deploy-wizard: needs an interactive terminal (TTY). it has no flags and cannot be piped.");
  process.exit(1);
}

const out = process.stdout;
const menu = (question, options) =>
  new Promise((resolve) => {
    let i = 0;
    const draw = (first) => {
      if (!first) out.write(`\x1b[${options.length}A`);
      for (const [k, o] of options.entries())
        out.write(`\x1b[2K${k === i ? "\x1b[36m> " : "  "}${o}\x1b[0m\n`);
    };
    out.write(`? ${question} (use arrow keys, enter to confirm)\n`);
    draw(true);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf) => {
      for (const key of buf.toString().match(/\x1b\[[A-D]|[\s\S]/g) ?? []) {
        if (key === "\x03") process.exit(130);
        if (key === "\x1b[A") i = (i + options.length - 1) % options.length;
        else if (key === "\x1b[B") i = (i + 1) % options.length;
        else if (key === "\r" || key === "\n") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          out.write(`ok ${question} ${options[i]}\n`);
          return resolve(options[i]);
        } else continue;
        draw(false);
      }
    };
    process.stdin.on("data", onData);
  });

const ask = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: out });
    rl.question(`? ${question} `, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });

const name = await ask("Service name:");
const region = await menu("Region:", ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1"]);
const size = await menu("Instance size:", ["small", "medium", "large"]);
const confirm = await menu("Write deploy.json?", ["Yes", "No"]);
if (confirm !== "Yes") {
  console.log("aborted, nothing written.");
  process.exit(1);
}
writeFileSync("deploy.json", `${JSON.stringify({ name, region, size }, null, 2)}\n`);
console.log("wrote deploy.json");
