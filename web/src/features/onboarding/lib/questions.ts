import type { SurveyQuestion } from "./surveyTypes";

import { i18nKey } from "@/src/features/i18n/i18nKey";
export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  {
    id: "role",
    type: "radio",
    question: i18nKey("What describes you best?"),
    options: [
      i18nKey("Software Engineer"),
      i18nKey("ML Engineer / Data Scientist"),
      i18nKey("Product Manager"),
      i18nKey("Domain Expert"),
      i18nKey("Executive or Manager"),
      i18nKey("Other"),
    ],
  },
  {
    id: "signupReason",
    type: "radio",
    question: i18nKey("Why are you signing up?"),
    options: [
      i18nKey("Invited by team"),
      i18nKey("Just looking around"),
      i18nKey("Evaluating / Testing Litefuse"),
      i18nKey("Start using Litefuse"),
      i18nKey("Migrating from other solution"),
      i18nKey("Migrating from self-hosted"),
    ],
  },
  {
    id: "referralSource",
    type: "text",
    question: i18nKey("Where did you hear about us?"),
    placeholder: i18nKey("GitHub, X, Reddit, colleague etc."),
  },
];

export const TOTAL_STEPS = SURVEY_QUESTIONS.length;
