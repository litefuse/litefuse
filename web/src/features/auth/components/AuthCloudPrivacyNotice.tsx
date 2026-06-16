import { env } from "@/src/env.mjs";

export const CloudPrivacyNotice = ({ action }: { action: string }) =>
  env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION !== undefined ? (
    <div className="text-muted-foreground mx-auto mt-10 max-w-lg text-center text-xs">
      By {action} you are agreeing to our{" "}
      <a
        href="https://litefuse.ai/terms"
        target="_blank"
        rel="noopener noreferrer"
        className="italic"
      >
        Terms and Conditions
      </a>
      ,{" "}
      <a
        href="https://litefuse.ai/privacy"
        rel="noopener noreferrer"
        className="italic"
      >
        Privacy Policy
      </a>
      , and{" "}
      <a
        href="https://litefuse.ai/cookie-policy"
        rel="noopener noreferrer"
        className="italic"
      >
        Cookie Policy
      </a>
      . You also confirm that the entered data is accurate.
    </div>
  ) : null;
