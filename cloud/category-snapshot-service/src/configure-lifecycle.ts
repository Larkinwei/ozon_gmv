import OSS from "ali-oss";

const environment = process.env;
for (const key of ["OSS_REGION", "OSS_BUCKET", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"]) {
  if (!environment[key]) {
    throw new Error(`缺少环境变量 ${key}`);
  }
}
const client = new OSS({
  region: environment.OSS_REGION!,
  bucket: environment.OSS_BUCKET!,
  accessKeyId: environment.OSS_ACCESS_KEY_ID!,
  accessKeySecret: environment.OSS_ACCESS_KEY_SECRET!,
  secure: true,
});

/** Retains immutable category snapshots for 24 months while keeping latest.json. */
await client.putBucketLifecycle(environment.OSS_BUCKET!, [{
  id: "category-snapshots-24-month-retention",
  prefix: "category-snapshots/v1/",
  status: "Enabled",
  days: 730,
}] as OSS.LifecycleRule[]);
