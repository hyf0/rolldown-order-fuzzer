import { projectStatus } from "./project.ts";

function main(): void {
  console.log(JSON.stringify(projectStatus, null, 2));
}

main();
