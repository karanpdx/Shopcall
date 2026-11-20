import { getDb } from "../../server/db";
import { repository } from "../../server/repository";
import { CallWorkspaceStore } from "./store";
import { CallWorkspaceService } from "./service";
import { productMediaService } from "../product-media/runtime";

export function callWorkspace() {
  return new CallWorkspaceService(new CallWorkspaceStore(getDb()), repository(), productMediaService());
}
