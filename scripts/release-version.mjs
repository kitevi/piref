import { pathToFileURL } from "node:url";

/** Encode one UTC instant as semver-shaped YYYY.MD.HMS, matching rfs. */
export function createReleaseVersion(date = new Date()) {
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0) {
    throw new Error("Release time must be a valid date with a non-negative year");
  }
  const monthDay = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const time = date.getUTCHours() * 10000 + date.getUTCMinutes() * 100 + date.getUTCSeconds();
  return `${date.getUTCFullYear()}.${monthDay}.${time}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(createReleaseVersion());
}
