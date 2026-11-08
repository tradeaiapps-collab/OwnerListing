import { withApi } from "../../../../../../src/server/api/with-api";
import { mfaSmsConfirmPost } from "../../../../../../src/server/mfa-handlers";

export const POST = withApi(mfaSmsConfirmPost);
