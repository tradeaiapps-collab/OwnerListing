import { mobileRefresh } from "../../../../../src/server/mobile-auth";
import { withApi } from "../../../../../src/server/api/with-api";

export const POST = withApi(mobileRefresh);
