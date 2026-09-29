import * as NodeFS from "node:fs";
import {
  makePackage,
  zipBytesPromise,
} from "../../../apps/server/src/scient/conversationFile/scic.test-fixtures.ts";

const destination = process.argv[2];
if (!destination) throw new Error("Pass a temporary destination path");
const packageFile = makePackage();
NodeFS.writeFileSync(destination, await zipBytesPromise(packageFile.files));
