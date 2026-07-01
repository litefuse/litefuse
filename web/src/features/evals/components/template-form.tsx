import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod/v4";
import { Input } from "@/src/components/ui/input";
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
import { api } from "@/src/utils/api";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createBooleanEvalOutputDefinition,
  createCategoricalEvalOutputDefinition,
  createNumericEvalOutputDefinition,
  extractVariables,
  getIsCharOrUnderscore,
  MinimumCategoricalCategoryCount,
  type PersistedEvalOutputDefinition,
  PersistedEvalOutputDefinitionSchema,
  resolvePersistedEvalOutputDefinition,
  ScoreDataTypeEnum,
} from "@langfuse/shared";
import router from "next/router";
import { type EvalTemplate } from "@langfuse/shared";
import { ModelParameters } from "@/src/components/ModelParameters";
import { type ModelParams, ZodModelConfig } from "@langfuse/shared";
import { PromptVariableListPreview } from "@/src/features/prompts/components/PromptVariableListPreview";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { getFinalModelParams } from "@/src/utils/getFinalModelParams";
import { useModelParams } from "@/src/features/playground/page/hooks/useModelParams";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { EvalReferencedEvaluators } from "@/src/features/evals/types";
import { CodeMirrorEditor } from "@/src/components/editor";
import { Card, CardContent } from "@/src/components/ui/card";
import { type RouterInput } from "@/src/utils/types";
import { useEvaluationModel } from "@/src/features/evals/hooks/useEvaluationModel";
import { Checkbox } from "@/src/components/ui/checkbox";
import { ManageDefaultEvalModel } from "@/src/features/evals/components/manage-default-eval-model";
import { DialogFooter, DialogBody } from "@/src/components/ui/dialog";
import { AlertCircle } from "lucide-react";
import { useValidateCustomModel } from "@/src/features/evals/hooks/useValidateCustomModel";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";

type PartialEvalTemplate = Omit<
  EvalTemplate,
  "id" | "version" | "createdAt" | "updatedAt"
> & { id?: string };

export const EvalTemplateForm = (props: {
  projectId: string;
  useDialog: boolean;
  existingEvalTemplate?: PartialEvalTemplate;
  onFormSuccess?: (template?: EvalTemplate) => void;
  onBeforeSubmit?: (
    template: RouterInput["evals"]["createTemplate"],
  ) => boolean;
  isEditing?: boolean;
  setIsEditing?: (isEditing: boolean) => void;
  preventRedirect?: boolean;
  cloneSourceId?: string | null;
}) => {
  return (
    <div className="w-full">
      <InnerEvalTemplateForm
        key={props.existingEvalTemplate?.id ?? "new"}
        {...props}
        existingEvalTemplateId={props.existingEvalTemplate?.id}
        existingEvalTemplateName={props.existingEvalTemplate?.name}
        cloneSourceId={props.cloneSourceId}
        onBeforeSubmit={props.onBeforeSubmit}
        preFilledFormValues={
          // if a langfuse template is selected, use that, else use the existing template
          // no langfuse template is selected if there is already an existing template
          props.existingEvalTemplate
            ? {
                name: props.existingEvalTemplate.name,
                prompt: props.existingEvalTemplate.prompt,
                vars: props.existingEvalTemplate.vars,
                outputSchema: props.existingEvalTemplate
                  .outputSchema as PersistedEvalOutputDefinition,
                selectedModel: props.existingEvalTemplate.provider
                  ? {
                      provider: props.existingEvalTemplate.provider as string,
                      model: props.existingEvalTemplate.model as string,
                      modelParams: props.existingEvalTemplate
                        .modelParams as ModelParams & {
                        maxTemperature: number;
                      },
                    }
                  : undefined,
              }
            : undefined
        }
      />
    </div>
  );
};

const selectedModelSchema = z.object({
  provider: z.string().min(1, "Select a provider"),
  model: z.string().min(1, "Select a model"),
  modelParams: ZodModelConfig,
});

const formSchema = z
  .object({
    name: z.string().min(1, "Enter a name"),
    prompt: z
      .string()
      .min(1, "Enter a prompt")
      .refine((val) => {
        const variables = extractVariables(val);
        const matches = variables.map((variable) => {
          // check regex here
          if (variable.match(/^[A-Za-z_]+$/)) {
            return true;
          }
          return false;
        });
        return !matches.includes(false);
      }, "Variables must only contain letters and underscores (_)"),

    variables: z.array(
      z.string().min(1, "Variables must have at least one character"),
    ),
    scoreDataType: z
      .enum([
        ScoreDataTypeEnum.NUMERIC,
        ScoreDataTypeEnum.BOOLEAN,
        ScoreDataTypeEnum.CATEGORICAL,
      ])
      .default(ScoreDataTypeEnum.NUMERIC),
    outputScore: z.string().min(1, "Enter a score function"),
    outputReasoning: z.string().min(1, "Enter a reasoning function"),
    categories: z.array(z.object({ value: z.string() })).default([]),
    shouldAllowMultipleMatches: z.boolean().default(false),
    referencedEvaluators: z
      .enum(EvalReferencedEvaluators)
      .optional()
      .default(EvalReferencedEvaluators.PERSIST),
    shouldUseDefaultModel: z.boolean().default(true),
  })
  .superRefine((values, ctx) => {
    if (values.scoreDataType !== ScoreDataTypeEnum.CATEGORICAL) {
      return;
    }

    const trimmedCategories = values.categories.map((category) =>
      category.value.trim(),
    );

    if (trimmedCategories.length < MinimumCategoricalCategoryCount) {
      ctx.addIssue({
        code: "custom",
        path: ["categories"],
        message: `Add at least ${MinimumCategoricalCategoryCount} categories`,
      });
      return;
    }

    trimmedCategories.forEach((category, index) => {
      if (!category) {
        ctx.addIssue({
          code: "custom",
          path: ["categories", index, "value"],
          message: "Enter a category",
        });
      }
    });

    const seenCategories = new Set<string>();
    trimmedCategories.forEach((category, index) => {
      if (!category) {
        return;
      }
      if (seenCategories.has(category)) {
        ctx.addIssue({
          code: "custom",
          path: ["categories", index, "value"],
          message: "Categories must be unique",
        });
        return;
      }
      seenCategories.add(category);
    });
  });

export type EvalTemplateFormPreFill = {
  name: string;
  prompt: string;
  vars: string[];
  outputSchema: PersistedEvalOutputDefinition;
  selectedModel?: {
    provider: string;
    model: string;
    modelParams: ModelParams & {
      maxTemperature: number;
    };
  };
};

const getDefaultOutputDefinitionFormValues = (params?: {
  scoreDataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  shouldAllowMultipleMatches?: boolean;
}) => {
  const scoreDataType = params?.scoreDataType ?? ScoreDataTypeEnum.NUMERIC;
  const shouldAllowMultipleMatches =
    params?.shouldAllowMultipleMatches ?? false;

  return {
    scoreDataType,
    outputReasoning: "One sentence reasoning for the score",
    outputScore:
      scoreDataType === ScoreDataTypeEnum.CATEGORICAL
        ? shouldAllowMultipleMatches
          ? "Choose all categories that apply."
          : "Choose exactly one category."
        : scoreDataType === ScoreDataTypeEnum.BOOLEAN
          ? "Return true if the evaluation passes and false otherwise."
          : "Score between 0 and 1. Score 0 if false or negative and 1 if true or positive.",
    categories: [] as { value: string }[],
    shouldAllowMultipleMatches,
  };
};

const toOutputDefinitionFormValues = (
  outputSchema?: PersistedEvalOutputDefinition | null,
) => {
  if (!outputSchema) return getDefaultOutputDefinitionFormValues();

  const parsedOutputDefinition =
    PersistedEvalOutputDefinitionSchema.safeParse(outputSchema);

  if (!parsedOutputDefinition.success) {
    return getDefaultOutputDefinitionFormValues();
  }

  const resolvedOutputDefinition = resolvePersistedEvalOutputDefinition(
    parsedOutputDefinition.data,
  );

  return {
    scoreDataType: resolvedOutputDefinition.dataType,
    outputReasoning: resolvedOutputDefinition.reasoningDescription,
    outputScore: resolvedOutputDefinition.scoreDescription,
    categories:
      resolvedOutputDefinition.dataType === ScoreDataTypeEnum.CATEGORICAL
        ? resolvedOutputDefinition.categories.map((category) => ({
            value: category,
          }))
        : [],
    shouldAllowMultipleMatches:
      resolvedOutputDefinition.dataType === ScoreDataTypeEnum.CATEGORICAL
        ? resolvedOutputDefinition.shouldAllowMultipleMatches
        : false,
  };
};

export const InnerEvalTemplateForm = (props: {
  projectId: string;
  useDialog: boolean;
  // pre-filled values from langfuse-defined template or template from db
  preFilledFormValues?: EvalTemplateFormPreFill;
  // template to be updated
  existingEvalTemplateId?: string;
  existingEvalTemplateName?: string;
  onFormSuccess?: (template?: EvalTemplate) => void;
  onBeforeSubmit?: (template: any) => boolean;
  isEditing?: boolean;
  setIsEditing?: (isEditing: boolean) => void;
  preventRedirect?: boolean;
  cloneSourceId?: string | null;
}) => {
  const capture = usePostHogClientCapture();
  const [formError, setFormError] = useState<string | null>(null);

  // Determine if we should use default model or custom model
  // If existing template has no provider, it was using default model
  const isExistingUsingDefault = props.preFilledFormValues?.selectedModel
    ? false
    : true;

  const { data: defaultModel } = api.defaultLlmModel.fetchDefaultModel.useQuery(
    { projectId: props.projectId },
    { enabled: !!props.projectId },
  );

  // updates the model params based on the pre-filled data
  // either form update or from langfuse-generated template
  const {
    modelParams,
    setModelParams,
    updateModelParamValue,
    setModelParamEnabled,
    availableModels,
    providerModelCombinations,
    availableProviders,
  } = useModelParams();

  useEvaluationModel(
    props.projectId,
    setModelParams,
    props.preFilledFormValues?.selectedModel,
  );

  const { isCustomModelValid } = useValidateCustomModel(
    availableProviders,
    props.preFilledFormValues?.selectedModel,
  );

  const outputDefinitionFormValues = toOutputDefinitionFormValues(
    props.preFilledFormValues?.outputSchema,
  );

  // updates the form based on the pre-filled data
  // either form update or from langfuse-generated template
  const form = useForm({
    resolver: zodResolver(formSchema),
    disabled: !props.isEditing,
    defaultValues: {
      name:
        props.existingEvalTemplateName ?? props.preFilledFormValues?.name ?? "",
      prompt: props.preFilledFormValues?.prompt ?? undefined,
      variables: props.preFilledFormValues?.vars ?? [],
      scoreDataType: outputDefinitionFormValues.scoreDataType,
      outputReasoning: outputDefinitionFormValues.outputReasoning,
      outputScore: outputDefinitionFormValues.outputScore,
      categories: outputDefinitionFormValues.categories,
      shouldAllowMultipleMatches:
        outputDefinitionFormValues.shouldAllowMultipleMatches,
      shouldUseDefaultModel: isExistingUsingDefault,
    },
  });

  const {
    fields: categoryFields,
    append,
    remove,
    replace,
  } = useFieldArray({
    control: form.control,
    name: "categories",
  });

  const useDefaultModel = form.watch("shouldUseDefaultModel");
  const scoreDataType = form.watch("scoreDataType");
  const shouldAllowMultipleMatches = form.watch("shouldAllowMultipleMatches");
  const isCategoricalOutput = scoreDataType === ScoreDataTypeEnum.CATEGORICAL;
  const isBooleanOutput = scoreDataType === ScoreDataTypeEnum.BOOLEAN;

  const extractedVariables = form.watch("prompt")
    ? extractVariables(form.watch("prompt")).filter(getIsCharOrUnderscore)
    : undefined;

  const utils = api.useUtils();
  const createEvalTemplateMutation = api.evals.createTemplate.useMutation({
    onSuccess: () => {
      utils.models.invalidate();
      if (
        form.getValues("referencedEvaluators") ===
          EvalReferencedEvaluators.UPDATE &&
        props.existingEvalTemplateId
      ) {
        showSuccessToast({
          title: "Updated evaluators",
          description:
            "Updated referenced evaluators to use new template version.",
        });
      }
    },
    onError: (error) => setFormError(error.message),
  });

  const evaluatorsByTemplateNameQuery =
    api.evals.jobConfigsByTemplateName.useQuery(
      {
        projectId: props.projectId,
        evalTemplateName: props.existingEvalTemplateName as string,
      },
      {
        enabled: !!props.existingEvalTemplateName,
      },
    );

  useEffect(() => {
    if (evaluatorsByTemplateNameQuery.data) {
      form.setValue(
        "referencedEvaluators",
        Boolean(evaluatorsByTemplateNameQuery.data.evaluators.length)
          ? EvalReferencedEvaluators.UPDATE
          : EvalReferencedEvaluators.PERSIST,
      );
    }
  }, [evaluatorsByTemplateNameQuery.data, form]);

  function onSubmit(values: z.infer<typeof formSchema>) {
    capture(
      props.isEditing
        ? "eval_templates:update_form_submit"
        : "eval_templates:new_form_submit",
    );

    const outputSchema =
      values.scoreDataType === ScoreDataTypeEnum.CATEGORICAL
        ? createCategoricalEvalOutputDefinition({
            scoreDescription: values.outputScore,
            reasoningDescription: values.outputReasoning,
            categories: values.categories.map((category) =>
              category.value.trim(),
            ),
            shouldAllowMultipleMatches: values.shouldAllowMultipleMatches,
          })
        : values.scoreDataType === ScoreDataTypeEnum.BOOLEAN
          ? createBooleanEvalOutputDefinition({
              scoreDescription: values.outputScore,
              reasoningDescription: values.outputReasoning,
            })
          : createNumericEvalOutputDefinition({
              scoreDescription: values.outputScore,
              reasoningDescription: values.outputReasoning,
            });

    const evalTemplate = {
      name: values.name,
      projectId: props.projectId,
      prompt: values.prompt,
      // Only include model details if not using default model
      provider: values.shouldUseDefaultModel
        ? undefined
        : modelParams.provider.value,
      model: values.shouldUseDefaultModel ? undefined : modelParams.model.value,
      modelParams: values.shouldUseDefaultModel
        ? undefined
        : getFinalModelParams(modelParams),
      vars: extractedVariables ?? [],
      outputSchema,
      referencedEvaluators: values.referencedEvaluators,
      sourceTemplateId: props.cloneSourceId ?? undefined,
    };

    // Only validate model if not using default
    if (!values.shouldUseDefaultModel) {
      const parsedModel = selectedModelSchema.safeParse({
        provider: evalTemplate.provider,
        model: evalTemplate.model,
        modelParams: evalTemplate.modelParams,
      });

      if (!parsedModel.success) {
        setFormError(
          `${parsedModel.error.issues[0].path}: ${parsedModel.error.issues[0].message}`,
        );
        return;
      }
    } else {
      if (!defaultModel) {
        setFormError(
          "No default evaluation model set. Set up default evaluation model or use a custom model",
        );
        return;
      }
    }

    // Check if we need to perform any pre-submission validation or confirmation
    if (props.onBeforeSubmit && !props.onBeforeSubmit(evalTemplate)) {
      return; // Stop submission - the parent will handle it
    }

    createEvalTemplateMutation
      .mutateAsync(evalTemplate)
      .then((res) => {
        props.onFormSuccess?.(res);
        form.reset();
        props.setIsEditing?.(false);
        if (props.preventRedirect) {
          return;
        }
        void router.push(
          `/project/${props.projectId}/evals/templates/${res.id}`,
        );
      })
      .catch((error) => {
        if ("message" in error && typeof error.message === "string") {
          setFormError(error.message as string);
          return;
        } else {
          setFormError(JSON.stringify(error));
          console.error(error);
        }
      });
  }

  const formBody = (
    <>
      {!props.existingEvalTemplateId ? (
        <>
          <div className="col-span-1 row-span-1 lg:col-span-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <>
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Select a template name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                </>
              )}
            />
          </div>
          <div className="col-span-1 row-span-1 lg:col-span-0"></div>
        </>
      ) : undefined}

      {/* Model Selection Section */}
      <Card>
        <CardContent>
          <p className="my-2 font-semibold">Model</p>
          <FormField
            control={form.control}
            name="shouldUseDefaultModel"
            render={({ field }) => (
              <FormItem className="mt-3 flex flex-row items-center space-y-0 space-x-3">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={!props.isEditing}
                  />
                </FormControl>
                <div className="space-y-0 leading-none">
                  <FormLabel>Use default evaluation model</FormLabel>
                  <FormDescription className="text-xs">
                    <ManageDefaultEvalModel
                      projectId={props.projectId}
                      variant="color-coded"
                      setUpMessage="No default model set. Set up default evaluation model"
                      className="text-sm font-normal"
                    />
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />
          {/* Only show model parameters if using custom model */}
          {!useDefaultModel &&
            (!props.isEditing && !isCustomModelValid ? (
              <div className="text-destructive mt-2 flex items-center space-x-1 text-sm">
                <AlertCircle className="h-4 w-4" />
                <p>
                  This evaluator is configured to use{" "}
                  {modelParams.provider.value}s models but no API key exists.
                  Add a key or choose another provider.
                </p>
              </div>
            ) : (
              <ModelParameters
                customHeader={
                  <p className="text-sm leading-none font-medium">
                    Custom model configuration
                  </p>
                }
                {...{
                  modelParams,
                  availableModels,
                  providerModelCombinations,
                  availableProviders,
                  updateModelParamValue: updateModelParamValue,
                  setModelParamEnabled,
                  modelParamsDescription:
                    "Select a model which supports function calling.",
                }}
                formDisabled={!props.isEditing}
              />
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="my-2 font-semibold">Prompt</p>
            <FormField
              control={form.control}
              name="prompt"
              render={({ field }) => (
                <>
                  <FormItem>
                    <FormLabel>Evaluation prompt</FormLabel>
                    <FormDescription>
                      Define your llm-as-a-judge evaluation template. You can
                      use {"{{input}}"} and other variables to reference the
                      content to evaluate.
                    </FormDescription>
                    <FormControl>
                      <CodeMirrorEditor
                        value={field.value}
                        onChange={field.onChange}
                        editable={props.isEditing}
                        mode="prompt"
                        minHeight={200}
                        maxHeight="50dvh"
                      />
                    </FormControl>
                    <FormMessage />
                    <PromptVariableListPreview
                      variables={extractedVariables ?? []}
                    />
                  </FormItem>
                </>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="outputReasoning"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Score reasoning prompt</FormLabel>
                <FormDescription>
                  Define how the LLM should explain its evaluation. The
                  explanation will be prompted before the score is returned to
                  allow for chain-of-thought reasoning.
                </FormDescription>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="scoreDataType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Score type</FormLabel>
                <FormDescription>
                  Choose whether the evaluator should return a numeric score, a
                  boolean verdict, or one of a fixed set of categories.
                </FormDescription>
                <Select
                  value={field.value}
                  disabled={!props.isEditing}
                  onValueChange={(value) => {
                    const nextScoreDataType = value as
                      | typeof ScoreDataTypeEnum.NUMERIC
                      | typeof ScoreDataTypeEnum.BOOLEAN
                      | typeof ScoreDataTypeEnum.CATEGORICAL;
                    const nextShouldAllowMultipleMatches =
                      nextScoreDataType === ScoreDataTypeEnum.CATEGORICAL
                        ? form.getValues("shouldAllowMultipleMatches")
                        : false;
                    const defaults = getDefaultOutputDefinitionFormValues({
                      scoreDataType: nextScoreDataType,
                      shouldAllowMultipleMatches:
                        nextShouldAllowMultipleMatches,
                    });

                    field.onChange(nextScoreDataType);
                    form.setValue("outputScore", defaults.outputScore);

                    if (nextScoreDataType === ScoreDataTypeEnum.CATEGORICAL) {
                      if ((form.getValues("categories") ?? []).length === 0) {
                        replace(
                          Array.from(
                            { length: MinimumCategoricalCategoryCount },
                            () => ({ value: "" }),
                          ),
                        );
                      }
                    } else {
                      form.setValue("shouldAllowMultipleMatches", false);
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ScoreDataTypeEnum.NUMERIC}>
                        Numeric
                      </SelectItem>
                      <SelectItem value={ScoreDataTypeEnum.BOOLEAN}>
                        Boolean
                      </SelectItem>
                      <SelectItem value={ScoreDataTypeEnum.CATEGORICAL}>
                        Categorical
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {isCategoricalOutput ? (
            <FormField
              control={form.control}
              name="categories"
              render={() => (
                <FormItem>
                  <FormLabel>Categories</FormLabel>
                  <FormDescription>
                    Add the allowed category values the model may return.
                    Categories must be exhaustive.
                  </FormDescription>
                  <div className="flex flex-col gap-3">
                    {categoryFields.map((categoryField, index) => (
                      <div
                        key={categoryField.id}
                        className="flex items-start gap-2"
                      >
                        <FormField
                          control={form.control}
                          name={`categories.${index}.value`}
                          render={({ field }) => (
                            <FormItem className="flex-1">
                              <FormControl>
                                <Input
                                  {...field}
                                  placeholder={`Category ${index + 1}`}
                                  disabled={!props.isEditing}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            !props.isEditing ||
                            categoryFields.length <=
                              MinimumCategoricalCategoryCount
                          }
                          onClick={() => remove(index)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="w-fit"
                      disabled={!props.isEditing}
                      onClick={() => append({ value: "" })}
                    >
                      Add category
                    </Button>
                  </div>
                  <FormField
                    control={form.control}
                    name="shouldAllowMultipleMatches"
                    render={({ field }) => (
                      <FormItem className="mt-3 flex flex-row items-center gap-3 space-y-0">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(checked) => {
                              field.onChange(Boolean(checked));
                              form.setValue(
                                "outputScore",
                                getDefaultOutputDefinitionFormValues({
                                  scoreDataType: ScoreDataTypeEnum.CATEGORICAL,
                                  shouldAllowMultipleMatches: Boolean(checked),
                                }).outputScore,
                              );
                            }}
                            disabled={!props.isEditing}
                          />
                        </FormControl>
                        <div className="leading-none">
                          <FormLabel>Allow multiple category matches</FormLabel>
                          <FormDescription className="text-xs">
                            Create one categorical score for each selected
                            category.
                          </FormDescription>
                        </div>
                      </FormItem>
                    )}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}

          <FormField
            control={form.control}
            name="outputScore"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {isCategoricalOutput
                    ? "Category selection prompt"
                    : isBooleanOutput
                      ? "Boolean verdict prompt"
                      : "Score range prompt"}
                </FormLabel>
                <FormDescription>
                  {isCategoricalOutput
                    ? shouldAllowMultipleMatches
                      ? "Define how the LLM should choose one or more categories from the list above."
                      : "Define how the LLM should choose exactly one category from the list above."
                    : isBooleanOutput
                      ? "Define how the LLM should return either true or false based on the evaluation criteria."
                      : "Define how the LLM should return the evaluation score in natural language. Needs to yield a numeric value."}
                </FormDescription>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>
    </>
  );

  const formFooter = (
    <div className="flex w-full flex-col items-end gap-4">
      {props.isEditing && (
        <Button
          type="submit"
          loading={createEvalTemplateMutation.isPending}
          className="max-w-fit"
        >
          Save
        </Button>
      )}
      {formError ? (
        <p className="text-red w-full text-center">
          <span className="font-bold">Error:</span> {formError}
        </p>
      ) : null}
    </div>
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="mt-2 space-y-4">
        {props.useDialog ? <DialogBody>{formBody}</DialogBody> : formBody}

        {props.useDialog ? (
          <DialogFooter>{formFooter}</DialogFooter>
        ) : (
          formFooter
        )}
      </form>
    </Form>
  );
};
