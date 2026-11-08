import { withApi } from "../../../../../../src/server/api/with-api";
import { mfaTotpConfirmPost } from "../../../../../../src/server/mfa-handlers";

export const POST = withApi(mfaTotpConfirmPost);
