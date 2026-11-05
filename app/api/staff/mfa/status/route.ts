import { withApi } from "../../../../../src/server/api/with-api";
import { mfaStatusGet } from "../../../../../src/server/mfa-handlers";

export const GET = withApi(mfaStatusGet);
