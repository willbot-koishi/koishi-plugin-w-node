import WNode from "../src";
import path from "node:path";

export interface Cmd {
  name: string;
  action: (argv: { options?: any }, ...args: any[]) => Promise<any> | any;
}

export async function loadService(
  config: any = {
    packagePath: path.resolve(__dirname, "../../../cache/node"),
    registry: "https://registry.npmmirror.com/",
  },
) {
  const cmdMap: Record<string, Cmd> = {};

  const buildCommand = (cmd: Cmd) => {
    const command = {
      action(fn: any) {
        cmd.action = (argv, ...args) => {
          return fn(
            {
              session: {
                text: (...args: any[]) => {
                  return (
                    "i18n: " +
                    args
                      .map((arg) =>
                        typeof arg === "string" ? arg : JSON.stringify(arg),
                      )
                      .join(" ")
                  );
                },
              },
              options: {},
              ...argv,
            },
            ...args,
          );
        };
        return command;
      },
      option() {
        return command;
      },
      alias() {
        return command;
      },
    };
    return command;
  };
  const ctx = {
    command(def: string) {
      const name = def.split(" ")[0];
      const cmd = {
        name,
      } as Cmd;
      cmdMap[name] = cmd;
      return buildCommand(cmd);
    },
    i18n: {
      define: (a, b) => b,
    },
    logger: {
      error: console.error,
      info: console.log,
    },
  };

  const node = new WNode(ctx as any, config);
  await node.start();

  return { node, cmdMap };
}
