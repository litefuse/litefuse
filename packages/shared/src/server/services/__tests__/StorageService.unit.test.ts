import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { StorageServiceFactory } from "../StorageService";

vi.mock("../../../env", () => ({
  env: { LITEFUSE_S3_UPLOAD_ENABLE_BUFFERED: "false" },
}));
vi.mock("../../logger", () => ({ logger: {} }));

const mib = 1024 * 1024;

it.each([undefined, 100 * mib])(
  "only overrides SDK part size when explicitly configured (%s bytes)",
  async (s3SdkPartSizeBytes) => {
    const storage = StorageServiceFactory.getInstance({
      bucketName: "exports",
      accessKeyId: undefined,
      secretAccessKey: undefined,
      endpoint: undefined,
      region: "us-east-1",
      forcePathStyle: false,
      useAzureBlob: false,
      useGoogleCloudStorage: false,
      awsSse: undefined,
      awsSseKmsKeyId: undefined,
    });
    const uploadFile = vi.spyOn(storage, "uploadFile").mockResolvedValue();
    const file = {
      fileName: "export.csv",
      fileType: "text/csv",
      data: Readable.from(["id\n1\n"]),
    };

    await storage.uploadFileBuffered({
      ...file,
      partSizeBytes: 10 * mib,
      s3SdkPartSizeBytes,
    });

    expect(uploadFile).toHaveBeenCalledExactlyOnceWith({
      ...file,
      partSize: s3SdkPartSizeBytes,
    });
  },
);
