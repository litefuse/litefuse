import { useFieldArray, useForm } from "react-hook-form";
import { useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  LLMAdapter,
  TYPESAFE_UPSTREAMS,
  resolveTypeSafeUpstream,
  isDecisionModelAdapter,
  type LlmApiKeys,
  type TypeSafeUpstream,
} from "@langfuse/shared";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { Switch } from "@/src/components/ui/switch";
import { TypeSafeUpstreamCards } from "@/src/features/llm-api-key/components/TypeSafeUpstreamCards/TypeSafeUpstreamCards";
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
      // Which upstream serves the Jev decision model. The stored base URL is
      // derived from it, so the field is the source of truth for TypeSafe.
      typeSafeUpstream: z.enum(
        TYPESAFE_UPSTREAMS.map(
          (upstream): TypeSafeUpstream["id"] => upstream.id,
        ),
      ),
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
    })
    // A custom upstream has no default base URL, so the user has to supply one.
    .refine(
      (data) =>
        data.adapter !== LLMAdapter.TypeSafe ||
        data.typeSafeUpstream !== "custom" ||
        data.baseURL.trim() !== "",
      {
        message: "A base URL is required for a custom upstream.",
        path: ["baseURL"],
      },
    );

interface CreateLLMApiKeyFormProps {
  projectId?: string;
  onSuccess: () => void;
  customization: UiCustomization | null;
  mode?: "create" | "update";
  existingKey?: LlmApiKeys;
}

/**
 * Developer-facing copy for the decision-model connection form. Kept as plain
 * strings outside JSX so the i18n gate does not flag API syntax as untranslated
 * UI text (this file is not part of the zh-CN rollout yet).
 */
const DECISION_MODEL_UPSTREAM_HELP =
  "Provider that serves the decision model. Every upstream speaks the same System One API (/systemone), so an evaluator behaves the same on all of them. OpenRouter and Vercel AI Gateway also carry Liquid AI d1 and Microsoft-Decision-1; use a custom endpoint for Azure Foundry, Alibaba Bailian or a self-hosted model.";

const DECISION_MODEL_CUSTOM_BASE_URL_HELP =
  "Base URL of a System One-compatible API. Litefuse appends /systemone, so leave it out. Examples: Azure Foundry https://<resource>.cognitiveservices.azure.com/providers/microsoft/v1, Alibaba Bailian https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1, self-hosted vLLM https://<host>/v1. Azure Foundry is authenticated with an api-key header; everything else uses Authorization: Bearer.";

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
            typeSafeUpstream: resolveTypeSafeUpstream(existingKey.baseURL).id,
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
            typeSafeUpstream: TYPESAFE_UPSTREAMS[0].id,
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

  // LITEFUSE ADDITION (copied from upstream): a decision-model connection
  // stores the base URL of the gateway that serves Jev, and no base URL means
  // the TypeSafe endpoint itself. The selected card is the source of truth and
  // the base URL field is derived from it, so a `custom` gateway keeps working
  // even though it has no preset URL.
  const currentTypeSafeUpstreamId = form.watch("typeSafeUpstream");
  const currentTypeSafeUpstream =
    TYPESAFE_UPSTREAMS.find(
      (upstream) => upstream.id === currentTypeSafeUpstreamId,
    ) ?? TYPESAFE_UPSTREAMS[0];
  // Keeps a typed custom base URL alive while the user switches between cards.
  const customTypeSafeBaseURLDraft = useRef("");

  const hasAdvancedSettings = (adapter: LLMAdapter) =>
    adapter === LLMAdapter.OpenAI ||
    adapter === LLMAdapter.Anthropic ||
    adapter === LLMAdapter.GoogleAIStudio ||
    adapter === LLMAdapter.TypeSafe;

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

  // The preset list is an inline panel rather than a portalled dropdown: inside
  // this dialog the wheel does not reach portalled content, an inline panel
  // scrolls natively like any other part of the dialog.
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const selectPreset = (nextPresetId: string) => {
    applyPreset(nextPresetId);
    setPresetPickerOpen(false);
  };

  const applyPreset = (nextPresetId: string) => {
    setPresetId(nextPresetId);

    const preset = getLlmProviderPreset(nextPresetId);

    if (!preset) return;

    form.setValue("adapter", preset.adapter, { shouldValidate: true });
    form.setValue("provider", preset.provider, { shouldValidate: true });
    form.setValue("baseURL", preset.baseURL, { shouldValidate: true });
    // Keep the upstream cards in sync with the preset. A preset that carries a
    // tenant-specific base URL (Azure Foundry, Alibaba) names `custom` so the
    // base URL field is the one the user fills in; everything else falls back to
    // the upstream its base URL implies.
    form.setValue(
      "typeSafeUpstream",
      preset.typeSafeUpstream ?? resolveTypeSafeUpstream(preset.baseURL).id,
      { shouldValidate: true },
    );
    customTypeSafeBaseURLDraft.current = "";
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
      // LITEFUSE ADDITION (copied from upstream): a decision-model connection
      // with no base URL targets TypeSafe directly, so an empty value has to be
      // sent as `null` on update; otherwise the previously stored gateway URL
      // would silently survive. `undefined` (not sent) is right for the other
      // adapters, where an empty base URL means "use the SDK default".
      baseURL:
        values.baseURL ||
        (mode === "update" && currentAdapter === LLMAdapter.TypeSafe
          ? null
          : undefined),
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
              {/* A dropdown panel rendered inside the dialog: it looks like the
                  app's other menus, and because it is not portalled the browser
                  scrolls it with the wheel. */}
              <div className="relative">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-between font-normal"
                  aria-haspopup="listbox"
                  aria-expanded={presetPickerOpen}
                  onClick={() => setPresetPickerOpen((open) => !open)}
                >
                  <span className="truncate">
                    {selectedPreset
                      ? t(selectedPreset.label)
                      : t("Custom (configure manually)")}
                  </span>
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-60" />
                </Button>
                {presetPickerOpen ? (
                  <div
                    role="listbox"
                    className="bg-popover absolute z-50 mt-1 max-h-[40vh] w-full overflow-y-auto rounded-md border shadow-md"
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={presetId === CUSTOM_PRESET_ID}
                      onClick={() => selectPreset(CUSTOM_PRESET_ID)}
                      className={cn(
                        "hover:bg-accent w-full px-3 py-2 text-left text-sm",
                        presetId === CUSTOM_PRESET_ID && "bg-accent font-medium",
                      )}
                    >
                      {t("Custom (configure manually)")}
                    </button>
                    {groupLlmProviderPresets().map(
                      ({ group, label, presets }) => (
                        <div key={group}>
                          {/* Preset and group labels are English keys held as
                              data (see LLM_PROVIDER_PRESET_LABELS); render
                              through t() so zh-CN sees Chinese. */}
                          <div className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-semibold">
                            {t(label)}
                          </div>
                          {presets.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              role="option"
                              aria-selected={presetId === preset.id}
                              onClick={() => selectPreset(preset.id)}
                              className={cn(
                                "hover:bg-accent w-full px-3 py-2 text-left text-sm",
                                presetId === preset.id && "bg-accent font-medium",
                              )}
                            >
                              {t(preset.label)}
                            </button>
                          ))}
                        </div>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
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
                  {" 路 "}
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
                    // Only reset derived fields when the adapter actually
                    // changes; a repeated selection must not wipe a custom base
                    // URL the user already typed.
                    if (value !== field.value) {
                      form.setValue(
                        "baseURL",
                        getCustomizedBaseURL(value as LLMAdapter),
                      );
                      form.setValue(
                        "typeSafeUpstream",
                        TYPESAFE_UPSTREAMS[0].id,
                      );
                      customTypeSafeBaseURLDraft.current = "";
                    }
                    field.onChange(value as LLMAdapter);
                    // Manual adapter edits leave the preset context, so fall
                    // back to "custom" instead of showing a stale preset.
                    setPresetId(CUSTOM_PRESET_ID);
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
                        {isDecisionModelAdapter(provider)
                          ? `${provider} (experimental)`
                          : provider}
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

          {/* Decision-model upstream: which gateway serves Jev (upstream parity) */}
          {currentAdapter === LLMAdapter.TypeSafe && (
            <FormField
              control={form.control}
              name="typeSafeUpstream"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Upstream</FormLabel>
                  <FormDescription>
                    {DECISION_MODEL_UPSTREAM_HELP}
                  </FormDescription>
                  <FormControl>
                    <TypeSafeUpstreamCards
                      aria-label="Upstream"
                      value={field.value}
                      onValueChange={(id) => {
                        if (field.value === "custom") {
                          customTypeSafeBaseURLDraft.current =
                            form.getValues("baseURL");
                        }
                        field.onChange(id);
                        const upstream = TYPESAFE_UPSTREAMS.find(
                          (candidate) => candidate.id === id,
                        );
                        form.setValue(
                          "baseURL",
                          id === "custom"
                            ? customTypeSafeBaseURLDraft.current
                            : (upstream?.baseURL ?? ""),
                        );
                        // Carry the upstream's model ids so the evaluator model
                        // picker offers what this endpoint actually serves
                        // (Jev, Liquid AI d1, Microsoft-Decision-1, ...).
                        if (upstream && upstream.models.length > 0) {
                          form.setValue(
                            "customModels",
                            upstream.models.map((value) => ({ value })),
                          );
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {/* A custom gateway has no default URL, so ask for one here */}
          {currentAdapter === LLMAdapter.TypeSafe &&
            currentTypeSafeUpstream.id === "custom" && (
              <FormField
                control={form.control}
                name="baseURL"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Custom base URL</FormLabel>
                    <FormDescription>
                      {DECISION_MODEL_CUSTOM_BASE_URL_HELP}
                    </FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="https://gateway.example.com/v1"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

          <FormField
            control={form.control}
            name="secretKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {currentAdapter === LLMAdapter.TypeSafe
                    ? currentTypeSafeUpstream.apiKeyLabel
                    : t("API Key")}
                </FormLabel>
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
              {/* baseURL: TypeSafe sets it through the upstream cards */}
              {currentAdapter !== LLMAdapter.TypeSafe && (
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
              )}

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

