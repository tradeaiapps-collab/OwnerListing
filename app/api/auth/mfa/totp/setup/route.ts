import { withApi } from "../../../../../../src/server/api/with-api";
import { mfaTotpSetupPost } from "../../../../../../src/server/mfa-handlers";

export const POST = withApi(mfaTotpSetupPost);
