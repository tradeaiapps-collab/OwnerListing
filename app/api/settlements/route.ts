import { listGet, startPost } from "../../../src/server/settlement-route";
import { withApi } from "../../../src/server/api/with-api";

export const GET = withApi(listGet);
export const POST = withApi(startPost);
