import { withApi } from "../../../../../../src/server/api/with-api";
import { mfaSmsSetupPost } from "../../../../../../src/server/mfa-handlers";

export const POST = withApi(mfaSmsSetupPost);
