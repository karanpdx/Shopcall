import { getDb } from "../../server/db";
import { repository } from "../../server/repository";
import { CallWorkspaceStore } from "./store";
import { CallWorkspaceService } from "./service";

export function callWorkspace() {
  return new CallWorkspaceService(new CallWorkspaceStore(getDb()), repository());
}
