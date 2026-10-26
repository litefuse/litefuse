import { prepareEvaluatorGallery } from "@/src/features/evals/v2/fns/templateGallery/prepareEvaluatorGallery";

const judgeTemplate = {
  id: "evaluator-1",
  name: "Project exact match",
  type: "LLM_AS_JUDGE" as const,
  updatedAt: new Date("2026-08-11T10:00:00.000Z"),
  version: 1,
  createdByUser: null,
};

const codeTemplate = {
  id: "evaluator-2",
  name: "Project keyword match",
  type: "CODE" as const,
  sourceCodeLanguage: "TYPESCRIPT" as const,
  updatedAt: new Date("2026-08-12T10:00:00.000Z"),
  version: 1,
  createdByUser: null,
};

describe("prepareEvaluatorGallery", () => {
  it("groups project and managed examples for navigation", () => {
    const gallery = prepareEvaluatorGallery({
      customTemplates: [judgeTemplate, codeTemplate],
      customTemplateCount: 12,
      search: "",
    });

    expect(gallery.navigationItems[0]).toMatchObject({
      key: "custom",
      count: 12,
    });
    expect(gallery.sections[0]?.totalCount).toBe(12);
    expect(gallery.sections.map(({ key }) => key)).toEqual([
      "custom",
      "recommended",
      "conversation",
      "quality",
      "classifier",
      "retrieval",
      "safety",
      "coding-agents",
    ]);

    const recommendedSection = gallery.sections.find(
      ({ key }) => key === "recommended",
    );
    expect(
      recommendedSection?.templates.map((template) =>
        template.source === "managed" ? template.key : null,
      ),
    ).toEqual([
      "topic-decision-model",
      "out-of-scope-request",
      "quality-criterion",
    ]);
    const conversationSection = gallery.sections.find(
      ({ key }) => key === "conversation",
    );
    expect(
      conversationSection?.templates.map((template) =>
        template.source === "managed" ? template.key : null,
      ),
    ).toEqual([
      "chat-intent",
      "out-of-scope-request",
      "user-disagreement",
      "user-distress",
      "out-of-scope-decision-model",
      "frustration-decision-model",
      "conversation-signals",
    ]);
  });

  it("offers no code evaluators, neither as templates nor as project evaluators", () => {
    const gallery = prepareEvaluatorGallery({
      customTemplates: [judgeTemplate, codeTemplate],
      customTemplateCount: 12,
      search: "",
    });

    const managedTypes = gallery.sections.flatMap(({ templates }) =>
      templates.flatMap((template) =>
        template.source === "managed" ? [template.evaluator.type] : [],
      ),
    );
    expect(managedTypes).not.toContain("CODE");

    const customNames = gallery.sections.flatMap(({ templates }) =>
      templates.flatMap((template) =>
        template.source === "custom" ? [template.name] : [],
      ),
    );
    expect(customNames).toContain(judgeTemplate.name);
    expect(customNames).not.toContain(codeTemplate.name);
  });

  it("hides the project-template entry when nothing would be listed under it", () => {
    const gallery = prepareEvaluatorGallery({
      customTemplates: [],
      customTemplateCount: 0,
      search: "",
    });

    expect(gallery.navigationItems.map(({ key }) => key)).not.toContain(
      "custom",
    );
    expect(gallery.sections.map(({ key }) => key)).not.toContain("custom");
  });

  it("searches custom and managed template descriptions", () => {
    const gallery = prepareEvaluatorGallery({
      customTemplates: [judgeTemplate, codeTemplate],
      customTemplateCount: 0,
      search: "grounded",
    });

    expect(
      gallery.navigationItems.map(({ key, count }) => ({ key, count })),
    ).toEqual([
      { key: "recommended", count: 0 },
      { key: "conversation", count: 0 },
      { key: "quality", count: 0 },
      { key: "classifier", count: 0 },
      { key: "retrieval", count: 1 },
      { key: "safety", count: 0 },
      { key: "coding-agents", count: 0 },
    ]);
    expect(gallery.sections).toHaveLength(1);
    expect(gallery.sections[0]?.templates).toEqual([
      expect.objectContaining({
        source: "managed",
        key: "answer-groundedness",
      }),
    ]);
  });
});
