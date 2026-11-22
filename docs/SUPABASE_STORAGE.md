# Photo uploads on Vercel + Supabase (free tier)

Listing photos work with no ClamAV: every image is decoded and re-encoded with sharp (`IMAGE_SANITISER=sharp`), so metadata and hidden or appended data are dropped. Documents (PDF etc.) stay refused until ClamAV is set up (`CLAMD_*`). If `CLAMD_*` is also set, ClamAV scans the original too.

Vercel caps a request near 4.5 MB, so the browser shrinks big photos to a JPEG under 3.5 MB before sending.

## Steps for the owner (about 5 minutes)
1. Supabase dashboard, project `ownerlisting`, Storage, **New bucket**: name `ownerlisting-files`, **Private** (leave "Public" off).
2. Storage, **S3 Connection** (Settings): copy the endpoint, region, then **New access key**. Keep the secret out of chat.
3. Copy `deploy/vercel/storage.env.example` to `storage.env`, fill the two key lines, then in Vercel: project, Settings, Environment Variables, **Import .env**, choose `storage.env`, tick Production. Delete the file afterwards.
4. Redeploy (merge to main or Vercel, Deployments, Redeploy).
5. Check: `STORAGE_DRIVER=s3 ... npm run check:s3`, or just add a photo on a draft listing.

Notes: bucket stays private; the app serves photos itself. `S3_SSE=none` and `S3_CONDITIONAL_PUT=0` are needed because Supabase rejects those headers. Storage keys are random, so nothing is overwritten.
