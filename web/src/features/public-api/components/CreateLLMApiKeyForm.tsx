import { useFieldArray, useForm } from "react-hook-form";
import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { LLMAdapter, type LlmApiKeys } from "@langfuse/shared";
import { ChevronDown, PlusIcon, TrashIcon } from "lucide-react";
import { z } from "zod/v4";
import { Button } from "@/src/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/src/components/ui/form";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { Switch } from "@/src/components/ui/switch";
import {
  CUSTOM_PRESET_ID,
  getLlmProviderPreset,
  groupLlmProviderPresets,
  inferLlmProviderPresetId,
  type LlmProviderPreset,
} from "@/src/features/llm-api-key/providerPresets";
import { api } from "@/src/utils/api";
import { cn } from "@/src/utils/tailwind";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { DialogFooter } from "@/src/components/ui/dialog";
import { type UiCustomization } from "@/src/features/ui-customization/useUiCustomization";
import { DialogBody } from "@/src/components/ui/dialog";
import { env } from "@/src/env.mjs";

import { useTranslation } from "react-i18next";
import { i18nKey } from "@/src/features/i18n/i18nKey";
const isLangfuseCloud = Boolean(env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION);

const createFormSchema = (mode: "create" | "update") =>
  z
    .object({
      secretKey: z.string().optional(),
      provider: z
        .string()
        .min(1, "Please add a provider name that identifies this connection.")
        .regex(
          /^[^:]+$/,
          "Provider name cannot contain colons. Use a format like 'OpenRouter_Mistral' instead.",
        ),
      adapter: z.nativeEnum(LLMAdapter),
      baseURL: z.union([z.literal(""), z.url()]),
      withDefaultModels: z.boolean(),
      customModels: z.array(z.object({ value: z.string().min(1) })),
      awsAccessKeyId: z.string().optional(),
      awsSecretAccessKey: z.string().optional(),
      awsRegion: z.string().optional(),
      vertexAILocation: z.string().optional(),
      extraHeaders: z.array(
        z.object({
          key: z.string().min(1),
          value: mode === "create" ? z.string().min(1) : z.string().optional(),
        }),
      ),
    })
    .refine(
      (data) => {
        return data.withDefaultModels || data.customModels.length > 0;
      },
      {
        message: i18nKey(
          "At least one custom model name is required when default models are disabled.",
        ),
        path: ["withDefaultModels"],
      },
    )
    .refine((data) => mode === "update" || data.secretKey, {
      message: i18nKey("Secret key is required."),
      path: ["secretKey"],
    });

interface CreateLLMApiKeyFormProps {
  projectId?: string;
  onSuccess: () => void;
  customization: UiCustomization | null;
  mode?: "create" | "update";
  existingKey?: LlmApiKeys;
}

export function CreateLLMApiKeyForm({
  projectId,
  onSuccess,
  customization,
  mode = "create",
  existingKey,
}: CreateLLMApiKeyFormProps) {
  const { t } = useTranslation();
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const utils = api.useUtils();
  const capture = usePostHogClientCapture();

  const existingKeys = api.llmApiKey.all.useQuery(
    {
      projectId: projectId as string,
    },
    { enabled: Boolean(projectId) },
  );

  const mutCreateLlmApiKey = api.llmApiKey.create.useMutation({
    onSuccess: () => utils.llmApiKey.invalidate(),
  });

  const mutUpdateLlmApiKey = api.llmApiKey.update.useMutation({
    onSuccess: () => utils.llmApiKey.invalidate(),
  });

  const mutTestLLMApiKey = api.llmApiKey.test.useMutation();
  const mutTestUpdateLLMApiKey = api.llmApiKey.testUpdate.useMutation();

  const defaultAdapter: LLMAdapter =
    customization?.defaultModelAdapter &&
    customization.defaultModelAdapter in LLMAdapter
      ? LLMAdapter[customization.defaultModelAdapter as keyof typeof LLMAdapter]
      : LLMAdapter.OpenAI;

  const getCustomizedBaseURL = (adapter: LLMAdapter) => {
    switch (adapter) {
      case LLMAdapter.OpenAI:
        return customization?.defaultBaseUrlOpenAI ?? "";
      case LLMAdapter.Anthropic:
        return customization?.defaultBaseUrlAnthropic ?? "";
      default:
        return "";
    }
  };

  const formSchema = createFormSchema(mode);

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues:
      mode === "update" && existingKey
        ? {
            adapter: existingKey.adapter as LLMAdapter,
            provider: existingKey.provider,
            secretKey: "",
            baseURL:
              existingKey.baseURL ??
              getCustomizedBaseURL(existingKey.adapter as LLMAdapter),
            withDefaultModels: existingKey.withDefaultModels,
            customModels: existingKey.customModels.map((value) => ({ value })),
            extraHeaders:
              existingKey.extraHeaderKeys?.map((key) => ({ key, value: "" })) ??
              [],
            vertexAILocation: "",
            awsRegion: "",
            awsAccessKeyId: "",
            awsSecretAccessKey: "",
          }
        : {
            adapter: defaultAdapter,
            provider: "",
            secretKey: "",
            baseURL: getCustomizedBaseURL(defaultAdapter),
            withDefaultModels: true,
            customModels: [],
            extraHeaders: [],
            vertexAILocation: "global",
            awsRegion: "",
            awsAccessKeyId: "",
            awsSecretAccessKey: "",
          },
  });

  const currentAdapter = form.watch("adapter");

  const hasAdvancedSettings = (adapter: LLMAdapter) =>
    adapter === LLMAdapter.OpenAI ||
    adapter === LLMAdapter.Anthropic ||
    adapter === LLMAdapter.GoogleAIStudio;

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "customModels",
  });

  // Which provider preset is currently selected. "custom" keeps the previous
  // behaviour where the user configures adapter/baseURL/model names by hand.
  const [presetId, setPresetId] = useState<string>(() =>
    mode === "update" && existingKey
      ? inferLlmProviderPresetId({
          adapter: existingKey.adapter,
          baseURL: existingKey.baseURL,
        })
      : CUSTOM_PRESET_ID,
  );

  const selectedPreset: LlmProviderPreset | undefined =
    getLlmProviderPreset(presetId);

  const applyPreset = (nextPresetId: string) => {
    setPresetId(nextPresetId);

    const preset = getLlmProviderPreset(nextPresetId);

    if (!preset) return;

    form.setValue("adapter", preset.adapter, { shouldValidate: true });
    form.setValue("provider", preset.provider, { shouldValidate: true });
    form.setValue("baseURL", preset.baseURL, { shouldValidate: true });
    form.setValue("withDefaultModels", preset.withDefaultModels);
    replace(preset.customModels.map((value) => ({ value })));

    // Model names live behind the advanced settings toggle, so open it when the
    // preset ships an explicit model list.
    if (!preset.withDefaultModels) {
      setShowAdvancedSettings(true);
    }
  };

  const {
    fields: headerFields,
    append: appendHeader,
    remove: removeHeader,
  } = useFieldArray({
    control: form.control,
    name: "extraHeaders",
  });

  const renderCustomModelsField = () => (
    <FormField
      control={form.control}
      name="customModels"
      render={() => (
        <FormItem>
          <FormLabel>{t("Custom models")}</FormLabel>
          <FormDescription>
            {t("Custom model names accepted by given endpoint.")}
          </FormDescription>

          {fields.map((customModel, index) => (
            <span key={customModel.id} className="flex flex-row space-x-2">
              <Input
                {...form.register(`customModels.${index}.value`)}
                placeholder={t("Custom model name {{index}}", {
                  index: index + 1,
                })}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => remove(index)}
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            </span>
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={() => append({ value: "" })}
            className="w-full"
          >
            <PlusIcon className="mr-1.5 -ml-0.5 h-5 w-5" aria-hidden="true" />
            {t("Add custom model name")}
          </Button>
        </FormItem>
      )}
    />
  );

  const renderExtraHeadersField = () => (
    <FormField
      control={form.control}
      name="extraHeaders"
      render={() => (
        <FormItem>
          <FormLabel>{t("Extra Headers")}</FormLabel>
          <FormDescription>
            {t(
              "Optional additional HTTP headers to include with requests towards LLM provider. All header values stored encrypted",
            )}{" "}
            {isLangfuseCloud ? t("on our servers") : t("in your database")}.
          </FormDescription>

          {headerFields.map((header, index) => (
            <div key={header.id} className="flex flex-row space-x-2">
              <Input
                {...form.register(`extraHeaders.${index}.key`)}
                placeholder={t("Header name")}
              />
              <Input
                {...form.register(`extraHeaders.${index}.value`)}
                placeholder={
                  mode === "update" &&
                  existingKey?.extraHeaderKeys &&
                  existingKey.extraHeaderKeys[index]
                    ? "***"
                    : t("Header value")
                }
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => removeHeader(index)}
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="ghost"
            onClick={() => appendHeader({ key: "", value: "" })}
            className="w-full"
          >
            <PlusIcon className="mr-1.5 -ml-0.5 h-5 w-5" aria-hidden="true" />
            {t("Add Header")}
          </Button>
        </FormItem>
      )}
    />
  );

  // Disable provider and adapter fields in update mode
  const isFieldDisabled = (fieldName: string) => {
    if (mode !== "update") return false;
    return ["provider", "adapter"].includes(fieldName);
  };

  async function onSubmit(values: z.infer<typeof formSchema>) {
    if (!projectId) return console.error("No project ID found.");

    if (mode === "create") {
      if (
        existingKeys?.data?.data
          .map((k) => k.provider)
          .includes(values.provider)
      ) {
        form.setError("provider", {
          type: "manual",
          message: t("There already exists an API key for this provider."),
        });
        return;
      }
      capture("project_settings:llm_api_key_create", {
        provider: values.provider,
      });
    } else {
      capture("project_settings:llm_api_key_update", {
        provider: values.provider,
      });
    }

    const secretKey =
      mode === "update" && !values.secretKey ? undefined : values.secretKey;

    const extraHeaders =
      values.extraHeaders.length > 0
        ? values.extraHeaders.reduce(
            (acc, header) => {
              acc[header.key] = header.value ?? "";
              return acc;
            },
            {} as Record<string, string>,
          )
        : undefined;

    const newLlmApiKey = {
      id: existingKey?.id ?? "",
      projectId,
      secretKey: secretKey ?? "",
      provider: values.provider,
      adapter: values.adapter,
      baseURL: values.baseURL || undefined,
      withDefaultModels: values.withDefaultModels,
      config: undefined,
      customModels: values.customModels
        .map((m) => m.value.trim())
        .filter(Boolean),
      extraHeaders,
    };

    try {
      const testResult =
        mode === "create"
          ? await mutTestLLMApiKey.mutateAsync(newLlmApiKey)
          : await mutTestUpdateLLMApiKey.mutateAsync(newLlmApiKey);

      if (!testResult.success) throw new Error(testResult.error);
    } catch (error) {
      form.setError("root", {
        type: "manual",
        message:
          error instanceof Error
            ? error.message
            : "Could not verify the API key.",
      });

      return;
    }

    return (mode === "create" ? mutCreateLlmApiKey : mutUpdateLlmApiKey)
      .mutateAsync(newLlmApiKey)
      .then(() => {
        form.reset();
        onSuccess();
      })
      .catch((error) => {
        console.error(error);
      });
  }

  return (
    <Form {...form}>
      <form
        className={cn("flex flex-col gap-4 overflow-auto")}
        onSubmit={(e) => {
          e.stopPropagation(); // Prevent event bubbling to parent forms
          form.handleSubmit(onSubmit)(e);
        }}
      >
        <DialogBody>
          {/* Provider preset (create mode only; update mode locks adapter+provider) */}
          {mode === "create" && (
            <div className="space-y-2">
              <Label>Provider preset</Label>
              <p className="text-muted-foreground text-sm">
                Prefills the adapter, base URL and model names for a provider.
                Choose “Custom” to configure the connection entirely by hand.
              </p>
              <Select value={presetId} onValueChange={applyPreset}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent className="max-h-[50vh]">
                  <SelectItem value={CUSTOM_PRESET_ID}>
                    Custom (configure manually)
                  </SelectItem>
                  {groupLlmProviderPresets().map(
                    ({ group, label, presets }) => (
                      <SelectGroup key={group}>
                        <SelectLabel>{label}</SelectLabel>
                        {presets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ),
                  )}
                </SelectContent>
              </Select>
              {selectedPreset && (
                <p className="text-muted-foreground text-sm">
                  {selectedPreset.note ? `${selectedPreset.note} ` : ""}
                  <a
                    href={selectedPreset.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Docs
                  </a>
                  {" · "}
                  <a
                    href={selectedPreset.apiKeyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Get an API key
                  </a>
                </p>
              )}
            </div>
          )}

          {/* LLM adapter */}
          <FormField
            control={form.control}
            name="adapter"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("LLM adapter")}</FormLabel>
                <FormDescription>
                  {t("Schema that is accepted at that provider endpoint.")}
                </FormDescription>
                <Select
                  // Controlled, not defaultValue: selecting a provider preset
                  // writes the adapter through form.setValue, which an
                  // uncontrolled Select would not reflect.
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value as LLMAdapter);
                    // Manual adapter edits leave the preset context, so fall
                    // back to "custom" instead of showing a stale preset.
                    setPresetId(CUSTOM_PRESET_ID);
                    form.setValue(
                      "baseURL",
                      getCustomizedBaseURL(value as LLMAdapter),
                    );
                  }}
                  disabled={isFieldDisabled("adapter")}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t("Select a LLM provider")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {Object.values(LLMAdapter).map((provider) => (
                      <SelectItem value={provider} key={provider}>
                        {provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          {/* Provider name */}
          <FormField
            control={form.control}
            name="provider"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("Provider name")}</FormLabel>
                <FormDescription>
                  {t(
                    "Key to identify the connection within Litefuse. Cannot contain colons.",
                  )}
                </FormDescription>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={`e.g. ${currentAdapter}`}
                    disabled={isFieldDisabled("provider")}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="secretKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("API Key")}</FormLabel>
                <FormDescription>
                  {isLangfuseCloud
                    ? t("Your API keys are stored encrypted on our servers.")
                    : t("Your API keys are stored encrypted in your database.")}
                </FormDescription>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={
                      mode === "update"
                        ? existingKey?.displaySecretKey
                        : undefined
                    }
                    autoComplete="off"
                    spellCheck="false"
                    autoCapitalize="off"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {hasAdvancedSettings(currentAdapter) && (
            <div className="flex items-center">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="flex items-center pl-0"
                onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
              >
                <span>
                  {showAdvancedSettings
                    ? t("Hide advanced settings")
                    : t("Show advanced settings")}
                </span>
                <ChevronDown
                  className={`ml-1 h-4 w-4 transition-transform ${showAdvancedSettings ? "rotate-180" : "rotate-0"}`}
                />
              </Button>
            </div>
          )}

          {hasAdvancedSettings(currentAdapter) && showAdvancedSettings && (
            <div className="space-y-4 border-t pt-4">
              {/* baseURL */}
              <FormField
                control={form.control}
                name="baseURL"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("API Base URL")}</FormLabel>
                    <FormDescription>
                      {t(
                        "Leave blank to use the default base URL for the given LLM adapter.",
                      )}{" "}
                      {currentAdapter === LLMAdapter.OpenAI && (
                        <span>
                          {t("OpenAI default: https://api.openai.com/v1")}
                        </span>
                      )}
                      {currentAdapter === LLMAdapter.Anthropic && (
                        <span>
                          {t(
                            "Anthropic default: https://api.anthropic.com (excluding /v1/messages)",
                          )}
                        </span>
                      )}
                    </FormDescription>

                    <FormControl>
                      <Input {...field} placeholder={t("default")} />
                    </FormControl>

                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Extra Headers */}
              {[LLMAdapter.OpenAI, LLMAdapter.Anthropic].includes(
                currentAdapter,
              ) && renderExtraHeadersField()}

              {/* With default models */}
              <FormField
                control={form.control}
                name="withDefaultModels"
                render={({ field }) => (
                  <FormItem>
                    <span className="row flex">
                      <span className="flex-1">
                        <FormLabel>{t("Enable default models")}</FormLabel>
                        <FormDescription>
                          {t(
                            "Default models for the selected adapter will be available in Litefuse features.",
                          )}
                        </FormDescription>
                      </span>

                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </span>

                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Custom model names */}
              {renderCustomModelsField()}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <div className="flex flex-col gap-4">
            <Button
              type="submit"
              className="w-full"
              loading={form.formState.isSubmitting}
            >
              {mode === "create" ? t("Create connection") : t("Save changes")}
            </Button>
            {form.formState.errors.root && (
              <FormMessage>{form.formState.errors.root.message}</FormMessage>
            )}
          </div>
        </DialogFooter>
      </form>
    </Form>
  );
}
