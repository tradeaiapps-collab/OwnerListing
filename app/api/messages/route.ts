import { inboxGet } from "../../../src/server/transaction-message-route";
import { withApi } from "../../../src/server/api/with-api";

export const GET = withApi(inboxGet);
