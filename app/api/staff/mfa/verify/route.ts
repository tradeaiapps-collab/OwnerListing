import { withApi } from "../../../../../src/server/api/with-api";
import { mfaVerifyPost } from "../../../../../src/server/mfa-handlers";

export const POST = withApi(mfaVerifyPost);
