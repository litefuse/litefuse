import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/src/components/ui/alert";

export const SupportOrUpgradePage = ({
  title,
  description,
}: {
  title?: string;
  description?: string;
} = {}) => (
  <Alert>
    <AlertTitle>{title ?? "Access Restricted"}</AlertTitle>
    <AlertDescription>
      {description ?? "This feature is not available in this distribution."}
    </AlertDescription>
  </Alert>
);

export default SupportOrUpgradePage;
