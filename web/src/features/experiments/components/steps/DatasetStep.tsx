import React, { useState } from "react";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/src/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/src/components/ui/popover";
import {
  InputCommandEmpty,
  InputCommandGroup,
  InputCommandInput,
  InputCommandList,
  InputCommand,
  InputCommandItem,
} from "@/src/components/ui/input-command";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { Button } from "@/src/components/ui/button";
import { Info, CircleCheck, ChevronDown, CheckIcon } from "lucide-react";
import { cn } from "@/src/utils/tailwind";
import { type DatasetStepProps } from "@/src/features/experiments/types/stepProps";
import { StepHeader } from "@/src/features/experiments/components/shared/StepHeader";
import { api } from "@/src/utils/api";
import { format } from "date-fns";

import { useTranslation } from "react-i18next";
export const DatasetStep: React.FC<DatasetStepProps> = ({
  projectId,
  formState,
  datasetState,
  promptInfo,
}) => {
  const { t } = useTranslation();
  const { form } = formState;
  const {
    datasets,
    selectedDatasetId,
    expectedColumnsForDataset: expectedColumns,
    validationResult,
  } = datasetState;
  const { selectedPromptName, selectedPromptVersion } = promptInfo;
  const [datasetPopoverOpen, setDatasetPopoverOpen] = useState(false);

  // Fetch dataset versions when a dataset is selected
  const { data: datasetVersions } = api.datasets.listDatasetVersions.useQuery(
    {
      projectId,
      datasetId: selectedDatasetId || "",
    },
    {
      enabled: !!selectedDatasetId,
    },
  );

  return (
    <div className="space-y-6">
      <StepHeader
        title={t("Dataset Selection")}
        description={t(
          "Choose the dataset to run your experiment on. The dataset structure must match the prompt template variables.",
        )}
      />

      <FormField
        control={form.control}
        name="datasetId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("Dataset")}</FormLabel>
            <div className="flex items-center gap-2">
              <Popover
                open={datasetPopoverOpen}
                onOpenChange={setDatasetPopoverOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={datasetPopoverOpen}
                    className="flex-1 justify-between px-2 font-normal"
                  >
                    {field.value
                      ? datasets?.find((d) => d.id === field.value)?.name
                      : t("Select a dataset")}
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-(--radix-popover-trigger-width) overflow-auto p-0"
                  align="start"
                >
                  <InputCommand>
                    <InputCommandInput
                      placeholder={t("Search datasets...")}
                      className="h-9"
                      variant="bottom"
                    />
                    <InputCommandList>
                      <InputCommandEmpty>
                        {t("No dataset found.")}
                      </InputCommandEmpty>
                      <InputCommandGroup>
                        {(datasets ?? []).map((dataset) => (
                          <InputCommandItem
                            key={dataset.id}
                            onSelect={() => {
                              field.onChange(dataset.id);
                              form.clearErrors("datasetId");
                              setDatasetPopoverOpen(false);
                            }}
                          >
                            {dataset.name}
                            <CheckIcon
                              className={cn(
                                "ml-auto h-4 w-4",
                                dataset.id === field.value
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                          </InputCommandItem>
                        ))}
                      </InputCommandGroup>
                    </InputCommandList>
                  </InputCommand>
                </PopoverContent>
              </Popover>

              {selectedPromptName && selectedPromptVersion !== null && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="h-8">
                      {t("Expected columns")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <div className="space-y-2">
                      <h4 className="leading-none font-medium">
                        {t("Expected Dataset Structure")}
                      </h4>
                      <p className="text-muted-foreground text-sm">
                        {t("Based on prompt {{name}} v{{version}}", {
                          name: selectedPromptName,
                          version: selectedPromptVersion,
                        })}
                      </p>
                      <div className="space-y-1 pt-2">
                        <p className="text-sm font-medium">
                          {t("Input variables:")}
                        </p>
                        <ul className="list-inside list-disc text-sm">
                          {expectedColumns.inputVariables.map((variable) => (
                            <li key={variable}>{variable}</li>
                          ))}
                        </ul>
                        <p className="text-sm font-medium">
                          {t("Expected output:")}
                        </p>
                        <ul className="list-inside list-disc text-sm">
                          <li>
                            {expectedColumns.outputVariableName} (
                            {expectedColumns.outputVariableType})
                          </li>
                        </ul>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />

      {selectedDatasetId && datasetVersions && datasetVersions.length > 0 && (
        <FormField
          control={form.control}
          name="datasetVersion"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("Dataset Version (Optional)")}</FormLabel>
              <Select
                onValueChange={(value) => {
                  if (value === "latest") {
                    field.onChange(undefined);
                  } else {
                    field.onChange(new Date(value));
                  }
                }}
                value={field.value ? field.value.toISOString() : "latest"}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t("Latest version")} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="latest">
                    {t("Latest version (default)")}
                  </SelectItem>
                  {datasetVersions.map((version) => (
                    <SelectItem
                      key={version.toISOString()}
                      value={version.toISOString()}
                    >
                      {t("{{timestamp}} (UTC)", {
                        timestamp: format(version, "PPp"),
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                {t(
                  "Run the experiment using the dataset state at a specific point in time. Defaults to the latest version.",
                )}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {selectedDatasetId && (
        <>
          {validationResult?.isValid === false && (
            <Card className="border-dark-yellow bg-light-yellow relative overflow-hidden rounded-md shadow-none group-data-[collapsible=icon]:hidden">
              <CardHeader className="p-2">
                <CardTitle className="text-dark-yellow flex items-center justify-between text-sm">
                  <span>{t("Invalid configuration")}</span>
                  <Info className="h-4 w-4" />
                </CardTitle>
                <CardDescription className="text-foreground">
                  {validationResult?.message}
                </CardDescription>
              </CardHeader>
            </Card>
          )}
          {validationResult?.isValid === true && (
            <Card className="border-dark-green bg-light-green relative overflow-hidden rounded-md shadow-none group-data-[collapsible=icon]:hidden">
              <CardHeader className="p-2">
                <CardTitle className="text-dark-green flex items-center justify-between text-sm">
                  <span>{t("Valid configuration")}</span>
                  <CircleCheck className="h-4 w-4" />
                </CardTitle>
                <div className="text-sm">
                  {t(
                    "Matches between dataset items and prompt variables/placeholders",
                  )}
                  <ul className="my-2 ml-2 list-inside list-disc">
                    {Object.entries(validationResult.variablesMap ?? {}).map(
                      ([variable, count]) => (
                        <li key={variable}>
                          <strong>{variable}:</strong> {count} /{" "}
                          {validationResult?.isValid
                            ? validationResult.totalItems
                            : t("unknown")}
                        </li>
                      ),
                    )}
                  </ul>
                  {t(
                    "Items missing all required variables and placeholders will be excluded from the dataset run.",
                  )}
                </div>
              </CardHeader>
            </Card>
          )}
        </>
      )}
    </div>
  );
};
