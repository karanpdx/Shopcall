import { getDb } from "../../server/db";
import { repository } from "../../server/repository";
import { blobStore } from "../../server/storage";
import { CallWorkspaceStore } from "../call-workspace/store";
import { ProductMediaStore } from "./store";
import { ProductMediaService, type ProductMediaProvider } from "./service";

/** Read/enqueue/apply need no provider credentials; original photo remains usable. */
export function productMediaService() {
  return new ProductMediaService(new ProductMediaStore(getDb()), new CallWorkspaceStore(getDb()), repository(), () => blobStore());
}

export async function processNextMediaJob(provider?: ProductMediaProvider) {
  let configured = provider;
  if (!configured) {
    try { configured = (await import("./provider")).createProductMediaProvider(); }
    catch { return { processed: false, errorCode: "MEDIA_PROVIDER_NOT_CONFIGURED" }; }
  }
  return productMediaService().processNext(configured);
}
