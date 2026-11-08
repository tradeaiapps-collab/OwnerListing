import { listGet } from "../../../src/server/dispute-route";
import { withApi } from "../../../src/server/api/with-api";

export const GET = withApi(listGet);
