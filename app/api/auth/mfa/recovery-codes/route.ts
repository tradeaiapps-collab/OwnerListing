import { withApi } from "../../../../../src/server/api/with-api";
import { mfaRecoveryCodesPost } from "../../../../../src/server/mfa-handlers";

export const POST = withApi(mfaRecoveryCodesPost);
