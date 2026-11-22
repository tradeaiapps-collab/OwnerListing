# File storage bucket (AWS S3, Sydney)

Default provider: **AWS S3, `ap-southeast-2` (Sydney)**. It keeps Australian personal data (ID images) in Australia, and the app's S3 code needs no setting beyond the four `S3_*` values. Any S3-compatible service also works (see `docs/DEPLOYMENT.md`). Nothing here has been created: no account, bucket or key exists until John does the steps below.

## Files
| File | What it is |
|---|---|
| `bucket-policy.json` | Denies plain HTTP, TLS older than 1.2, and writes that are not encrypted `AES256`; stops the app key deleting anything outside `id/` and deleting versions. |
| `iam-policy.json` | Least-privilege policy for the app's IAM user: `GetObject` and `PutObject` on the bucket, `DeleteObject` on `id/*` only. No list, no admin. |
| `lifecycle.json` | `id/`: old versions deleted after 1 day (so a deleted ID image really goes). Other prefixes: old versions kept 90 days. Incomplete uploads cleaned up. |
| `cors.json` | Optional. Only needed if a web page ever fetches a signed link with JavaScript. Today links are opened as downloads, so skip it. |

Replace `BUCKET`, `ACCOUNT_ID`, `APP_IAM_USER` (and `DOMAIN` in cors) before applying.

## What John does (about 20 minutes)
1. Sign in to AWS (root account with MFA on). Region **Asia Pacific (Sydney)**.
2. S3, **Create bucket**: name like `ownerlisting-prod-files`, Block all public access = all four ticked, Bucket Versioning = Enable, Default encryption = SSE-S3.
3. Bucket, Permissions, **Bucket policy**: paste `bucket-policy.json` edited. (Create the IAM user in step 4 first, otherwise AWS rejects the unknown principal.)
4. IAM, Users, create `ownerlisting-app` (no console access). Add inline policy from `iam-policy.json`. Security credentials, **Create access key** (use case: application running outside AWS). Copy both values into Vercel only.
5. Bucket, Management, **Lifecycle rules**: easiest is CloudShell: `aws s3api put-bucket-lifecycle-configuration --bucket BUCKET --lifecycle-configuration file://lifecycle.json` (or the same via the console, one rule per prefix).
6. Vercel, both projects, Production, sensitive: `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION=ap-southeast-2`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Leave `S3_ENDPOINT`, `S3_SSE` and the rest blank.
7. From your PC with those values in the shell: `npm run check:s3`. It writes one tiny `id/` object, reads it, checks signed and unsigned links, then deletes it. Every line must say PASS. `npm run smoke:prod` runs it too when `S3_BUCKET` is set.
8. AWS Budgets: a monthly cost alert. Optional: cross-region replication for backups (not for `id/`, see `docs/DEPLOYMENT.md`).

## Notes
- Keys are `listings/`, `inspections/`, `investments/`, `signing/`, `prequal/` and `id/`. The app deletes only `id/` objects (retention job), so the policy lets only that prefix be deleted.
- Without `s3:ListBucket` a missing object answers 403 instead of 404; the app treats both as failure to read, which is fine.
- If you switch to `S3_SSE=aws:kms`, change the `DenyUnencryptedWrites` value to `aws:kms` and add `kms:GenerateDataKey` and `kms:Decrypt` on the key to the IAM policy.
- The check leaves a delete marker plus one old version of its test object; the lifecycle rule removes both within about 2 days.
- Rotate the access key yearly: create a second key, update Vercel, redeploy, run `check:s3`, then delete the old key.
- Not done: nobody has applied these files to a real bucket; the first real `check:s3` run may find a policy mistake. A security review of the upload path is still outstanding.
