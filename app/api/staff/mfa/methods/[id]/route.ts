import { withApi } from "../../../../../../src/server/api/with-api";
import { mfaMethodsDelete } from "../../../../../../src/server/mfa-handlers";

export const DELETE = withApi(mfaMethodsDelete);
