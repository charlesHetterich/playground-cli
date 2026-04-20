import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { BuildScreen } from "./BuildScreen.js";

export const buildCommand = new Command("build")
    .description("Build the project's contracts and frontend in parallel")
    .option("--dir <path>", "Project directory", process.cwd())
    .action(async (opts: { dir: string }) => {
        const ok = await new Promise<boolean>((resolve) => {
            const app = render(
                React.createElement(BuildScreen, {
                    projectDir: opts.dir,
                    onDone: (success: boolean) => {
                        app.unmount();
                        resolve(success);
                    },
                }),
            );
        });

        if (!ok) process.exit(1);
    });
