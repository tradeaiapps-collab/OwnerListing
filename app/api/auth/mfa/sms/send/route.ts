import { withApi } from "../../../../../../src/server/api/with-api";
import { mfaSmsSendPost } from "../../../../../../src/server/mfa-handlers";

export const POST = withApi(mfaSmsSendPost);
