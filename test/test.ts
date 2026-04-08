import { loadService } from "./testBase";
import * as semver from "semver";

(async () => {
  const p = "semver";
  const { node, cmdMap } = await loadService();

  // const installedVersion: string[] = [];
  // installedVersion.push(await node.install(p));
  // installedVersion.push(await node.install(p, "~6.1"));
  // installedVersion.push(await node.install(p, "2"));
  // installedVersion.push(await node.install(p, "~2.0.0-0 <2.0.1"));
  // //
  // console.log(installedVersion);
  //
  // console.log(await node.has(p, "*"));
  // console.log(await node.has(p, "2"));
  // console.log(await node.has(p, installedVersion[0]));
  // console.log(await node.has(p, installedVersion[1]));
  //
  // const s = await node.import(p);
  // console.log(s);

  // await node.remove(p, "2");
  // await node.remove(p);

  console.log(await cmdMap["node.install"].action({}, p));
  console.log(
    await cmdMap["node.install"].action({ options: { version: "~6.1" } }, p),
  );
  console.log(
    await cmdMap["node.install"].action({ options: { version: "2" } }, p),
  );
  console.log(
    await cmdMap["node.install"].action(
      { options: { version: "~2.0.0-0 <2.0.1" } },
      p,
    ),
  );
  console.log(await cmdMap["node.list"].action({}));
  console.log(await cmdMap["node.info"].action({}, p));
  console.log(
    await cmdMap["node.info"].action({ options: { version: "3" } }, p),
  );
  console.log(
    await cmdMap["node.info"].action({ options: { version: "2" } }, p),
  );

  console.log(
    await cmdMap["node.info"].action({ options: { version: "2" } }, p),
  );

  console.log(
    await cmdMap["node.exec"].action(
      { options: { version: "latest", var: p } },
      p,
      (() =>
        semver
          .sort(["11.45.13", "11.45.14", "1.2.3", "11.45.14-1919810"])
          .join(", ")).toString(),
    ),
  );

  console.log(
    await cmdMap["node.remove"].action({ options: { version: "2" } }, p),
  );
  console.log(
    await cmdMap["node.remove"].action({ options: { version: "2" } }, p),
  );
  console.log(await cmdMap["node.remove"].action({ options: {} }, p));
  console.log(await cmdMap["node.remove"].action({ options: {} }, p));
})();
