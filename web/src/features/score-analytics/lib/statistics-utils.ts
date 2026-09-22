import { i18nKey } from "@/src/features/i18n/i18nKey";
/**
 * Statistical calculation utilities for score comparison analytics
 * Provides functions for calculating Cohen's Kappa, F1 Score, Overall Agreement,
 * and interpretation functions for various statistical metrics.
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface ConfusionMatrixRow {
  rowCategory: string;
  colCategory: string;
  count: number;
}

export interface InterpretationResult {
  /** i18n key; "N/A" is also the sentinel the cards branch on. */
  strength: string;
  color: string;
  /** i18n key, interpolated with `descriptionParams` at the render site. */
  description: string;
  descriptionParams?: Record<string, string | number>;
}

// ============================================================================
// Categorical Statistics Calculations
// ============================================================================

/**
 * Calculate Cohen's Kappa for inter-rater agreement
 * Cohen's Kappa measures agreement between two raters while accounting for
 * chance agreement. Range: [-1, 1] where 1 = perfect agreement.
 *
 * Formula: κ = (Po - Pe) / (1 - Pe)
 * Where Po = observed agreement, Pe = expected agreement by chance
 *
 * @param confusionMatrix - Array of confusion matrix cells
 * @returns Cohen's Kappa coefficient or null if calculation not possible
 */
export function calculateCohensKappa(
  confusionMatrix: ConfusionMatrixRow[],
): number | null {
  if (!confusionMatrix || confusionMatrix.length === 0) {
    return null;
  }

  // Calculate total count
  const total = confusionMatrix.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return null;
  }

  // Build set of all categories
  const categories = Array.from(
    new Set([
      ...confusionMatrix.map((r) => r.rowCategory),
      ...confusionMatrix.map((r) => r.colCategory),
    ]),
  ).sort();

  // Calculate observed agreement (Po)
  const observedAgreement =
    confusionMatrix
      .filter((r) => r.rowCategory === r.colCategory)
      .reduce((sum, r) => sum + r.count, 0) / total;

  // Calculate marginal totals for expected agreement
  const score1Totals: Record<string, number> = {};
  const score2Totals: Record<string, number> = {};

  confusionMatrix.forEach((r) => {
    score1Totals[r.rowCategory] = (score1Totals[r.rowCategory] || 0) + r.count;
    score2Totals[r.colCategory] = (score2Totals[r.colCategory] || 0) + r.count;
  });

  // Calculate expected agreement (Pe)
  const expectedAgreement = categories.reduce((sum, cat) => {
    const p1 = (score1Totals[cat] || 0) / total;
    const p2 = (score2Totals[cat] || 0) / total;
    return sum + p1 * p2;
  }, 0);

  // Calculate Kappa
  const denominator = 1 - expectedAgreement;
  if (Math.abs(denominator) < 1e-10) {
    // Perfect expected agreement - return 1 if observed is also perfect
    return observedAgreement === 1 ? 1 : null;
  }

  const kappa = (observedAgreement - expectedAgreement) / denominator;

  // Round to 3 decimal places
  return Math.round(kappa * 1000) / 1000;
}

/**
 * Calculate weighted F1 score for multi-class classification
 * F1 is the harmonic mean of precision and recall, weighted by support.
 * Range: [0, 1] where 1 = perfect classification.
 *
 * @param confusionMatrix - Array of confusion matrix cells
 * @returns Weighted F1 score or null if calculation not possible
 */
export function calculateWeightedF1Score(
  confusionMatrix: ConfusionMatrixRow[],
): number | null {
  if (!confusionMatrix || confusionMatrix.length === 0) {
    return null;
  }

  const total = confusionMatrix.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return null;
  }

  // Get all unique categories
  const categories = Array.from(
    new Set(confusionMatrix.flatMap((r) => [r.rowCategory, r.colCategory])),
  ).sort();

  // Calculate F1 score for each category
  const f1Scores = categories.map((cat) => {
    // True Positives: both scores match this category
    const tp =
      confusionMatrix.find(
        (r) => r.rowCategory === cat && r.colCategory === cat,
      )?.count || 0;

    // False Positives: score2 is this category but score1 is not
    const fp = confusionMatrix
      .filter((r) => r.colCategory === cat && r.rowCategory !== cat)
      .reduce((sum, r) => sum + r.count, 0);

    // False Negatives: score1 is this category but score2 is not
    const fn = confusionMatrix
      .filter((r) => r.rowCategory === cat && r.colCategory !== cat)
      .reduce((sum, r) => sum + r.count, 0);

    // Calculate precision and recall
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

    // Calculate F1 score
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;

    // Support is the number of actual instances of this category
    const support = tp + fn;

    return { f1, support };
  });

  // Calculate weighted average F1 score
  const weightedF1 =
    f1Scores.reduce((sum, { f1, support }) => sum + f1 * support, 0) / total;

  // Round to 3 decimal places
  return Math.round(weightedF1 * 1000) / 1000;
}

/**
 * Calculate overall agreement (simple accuracy)
 * This is the percentage of cases where both scores agree.
 * Range: [0, 1] where 1 = 100% agreement.
 *
 * @param confusionMatrix - Array of confusion matrix cells
 * @returns Overall agreement percentage or null if calculation not possible
 */
export function calculateOverallAgreement(
  confusionMatrix: ConfusionMatrixRow[],
): number | null {
  if (!confusionMatrix || confusionMatrix.length === 0) {
    return null;
  }

  const total = confusionMatrix.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return null;
  }

  // Sum diagonal (matching categories)
  const matching = confusionMatrix
    .filter((r) => r.rowCategory === r.colCategory)
    .reduce((sum, r) => sum + r.count, 0);

  const agreement = matching / total;

  // Round to 3 decimal places
  return Math.round(agreement * 1000) / 1000;
}

/**
 * A correlation reads differently in each direction, and Chinese puts the sign
 * before the noun, so each (strength, direction) pair is its own key rather
 * than an interpolated word.
 */
const LINEAR_CORRELATION_DESCRIPTIONS = {
  veryStrong: {
    positive: i18nKey("Very strong positive linear correlation"),
    negative: i18nKey("Very strong negative linear correlation"),
  },
  strong: {
    positive: i18nKey("Strong positive linear correlation"),
    negative: i18nKey("Strong negative linear correlation"),
  },
  moderate: {
    positive: i18nKey("Moderate positive linear correlation"),
    negative: i18nKey("Moderate negative linear correlation"),
  },
  weak: {
    positive: i18nKey("Weak positive linear correlation"),
    negative: i18nKey("Weak negative linear correlation"),
  },
} as const;

const MONOTONIC_RELATIONSHIP_DESCRIPTIONS = {
  veryStrong: {
    positive: i18nKey("Very strong positive monotonic relationship"),
    negative: i18nKey("Very strong negative monotonic relationship"),
  },
  strong: {
    positive: i18nKey("Strong positive monotonic relationship"),
    negative: i18nKey("Strong negative monotonic relationship"),
  },
  moderate: {
    positive: i18nKey("Moderate positive monotonic relationship"),
    negative: i18nKey("Moderate negative monotonic relationship"),
  },
  weak: {
    positive: i18nKey("Weak positive monotonic relationship"),
    negative: i18nKey("Weak negative monotonic relationship"),
  },
} as const;

// ============================================================================
// Interpretation Functions
// ============================================================================

/**
 * Interpret Pearson correlation coefficient
 * Reference: Cohen, J. (1988). Statistical power analysis for the behavioral sciences.
 *
 * @param r - Pearson correlation coefficient
 * @returns Interpretation with strength, color, and description
 */
export function interpretPearsonCorrelation(
  r: number | null,
): InterpretationResult {
  if (r === null) {
    return {
      strength: "N/A",
      color: "gray",
      description: i18nKey("No data available"),
    };
  }

  const abs = Math.abs(r);
  const direction = r < 0 ? "negative" : "positive";

  if (abs >= 0.9) {
    return {
      strength: i18nKey("Very Strong"),
      color: "green",
      description: LINEAR_CORRELATION_DESCRIPTIONS.veryStrong[direction],
    };
  }
  if (abs >= 0.7) {
    return {
      strength: i18nKey("Strong"),
      color: "blue",
      description: LINEAR_CORRELATION_DESCRIPTIONS.strong[direction],
    };
  }
  if (abs >= 0.5) {
    return {
      strength: i18nKey("Moderate"),
      color: "yellow",
      description: LINEAR_CORRELATION_DESCRIPTIONS.moderate[direction],
    };
  }
  if (abs >= 0.3) {
    return {
      strength: i18nKey("Weak"),
      color: "orange",
      description: LINEAR_CORRELATION_DESCRIPTIONS.weak[direction],
    };
  }
  return {
    strength: i18nKey("Very Weak"),
    color: "red",
    description: i18nKey("Very weak or no linear correlation"),
  };
}

/**
 * Interpret Spearman rank correlation coefficient
 * Similar interpretation to Pearson but for monotonic relationships
 *
 * @param rho - Spearman's rho coefficient
 * @returns Interpretation with strength, color, and description
 */
export function interpretSpearmanCorrelation(
  rho: number | null,
): InterpretationResult {
  if (rho === null) {
    return {
      strength: "N/A",
      color: "gray",
      description: i18nKey("No data available"),
    };
  }

  const abs = Math.abs(rho);
  const direction = rho < 0 ? "negative" : "positive";

  if (abs >= 0.9) {
    return {
      strength: i18nKey("Very Strong"),
      color: "green",
      description: MONOTONIC_RELATIONSHIP_DESCRIPTIONS.veryStrong[direction],
    };
  }
  if (abs >= 0.7) {
    return {
      strength: i18nKey("Strong"),
      color: "blue",
      description: MONOTONIC_RELATIONSHIP_DESCRIPTIONS.strong[direction],
    };
  }
  if (abs >= 0.5) {
    return {
      strength: i18nKey("Moderate"),
      color: "yellow",
      description: MONOTONIC_RELATIONSHIP_DESCRIPTIONS.moderate[direction],
    };
  }
  if (abs >= 0.3) {
    return {
      strength: i18nKey("Weak"),
      color: "orange",
      description: MONOTONIC_RELATIONSHIP_DESCRIPTIONS.weak[direction],
    };
  }
  return {
    strength: i18nKey("Very Weak"),
    color: "red",
    description: i18nKey("Very weak or no monotonic relationship"),
  };
}

/**
 * Interpret Cohen's Kappa coefficient
 * Reference: Landis, J. R., & Koch, G. G. (1977). The measurement of observer
 * agreement for categorical data. Biometrics, 159-174.
 *
 * @param kappa - Cohen's Kappa coefficient
 * @returns Interpretation with strength, color, and description
 */
export function interpretCohensKappa(
  kappa: number | null,
): InterpretationResult {
  if (kappa === null) {
    return {
      strength: "N/A",
      color: "gray",
      description: i18nKey("No data available"),
    };
  }

  if (kappa >= 1.0) {
    return {
      strength: i18nKey("Perfect"),
      color: "green",
      description: i18nKey("perfect agreement between scores"),
    };
  }
  if (kappa >= 0.81) {
    return {
      strength: i18nKey("Almost Perfect"),
      color: "green",
      description: i18nKey("Almost perfect agreement between scores"),
    };
  }
  if (kappa >= 0.61) {
    return {
      strength: i18nKey("Substantial"),
      color: "blue",
      description: i18nKey("Substantial agreement between scores"),
    };
  }
  if (kappa >= 0.41) {
    return {
      strength: i18nKey("Moderate"),
      color: "yellow",
      description: i18nKey("Moderate agreement between scores"),
    };
  }
  if (kappa >= 0.21) {
    return {
      strength: i18nKey("Fair"),
      color: "orange",
      description: i18nKey("Fair agreement between scores"),
    };
  }
  if (kappa > 0) {
    return {
      strength: i18nKey("Slight"),
      color: "red",
      description: i18nKey("Slight agreement between scores"),
    };
  }
  return {
    strength: i18nKey("Poor"),
    color: "red",
    description: i18nKey("Poor agreement (worse than chance)"),
  };
}

/**
 * Interpret F1 score
 * Common thresholds for classification performance
 *
 * @param f1 - F1 score
 * @returns Interpretation with strength, color, and description
 */
export function interpretF1Score(f1: number | null): InterpretationResult {
  if (f1 === null) {
    return {
      strength: "N/A",
      color: "gray",
      description: i18nKey("No data available"),
    };
  }

  if (f1 >= 0.9) {
    return {
      strength: i18nKey("Excellent"),
      color: "green",
      description: i18nKey("Excellent classification performance"),
    };
  }
  if (f1 >= 0.8) {
    return {
      strength: i18nKey("Good"),
      color: "blue",
      description: i18nKey("Good classification performance"),
    };
  }
  if (f1 >= 0.6) {
    return {
      strength: i18nKey("Fair"),
      color: "yellow",
      description: i18nKey("Fair classification performance"),
    };
  }
  if (f1 >= 0.4) {
    return {
      strength: i18nKey("Poor"),
      color: "orange",
      description: i18nKey("Poor classification performance"),
    };
  }
  return {
    strength: i18nKey("Very Poor"),
    color: "red",
    description: i18nKey("Very poor classification performance"),
  };
}

/**
 * Interpret overall agreement percentage
 *
 * @param agreement - Overall agreement (0-1)
 * @returns Interpretation with strength, color, and description
 */
export function interpretOverallAgreement(
  agreement: number | null,
): InterpretationResult {
  if (agreement === null) {
    return {
      strength: "N/A",
      color: "gray",
      description: i18nKey("No data available"),
    };
  }

  const percentage = Math.round(agreement * 100);

  if (agreement >= 0.9) {
    return {
      strength: i18nKey("Excellent"),
      color: "green",
      description: i18nKey("{{percentage}}% of predictions match"),
      descriptionParams: { percentage },
    };
  }
  if (agreement >= 0.8) {
    return {
      strength: i18nKey("Good"),
      color: "blue",
      description: i18nKey("{{percentage}}% of predictions match"),
      descriptionParams: { percentage },
    };
  }
  if (agreement >= 0.6) {
    return {
      strength: i18nKey("Fair"),
      color: "yellow",
      description: i18nKey("{{percentage}}% of predictions match"),
      descriptionParams: { percentage },
    };
  }
  if (agreement >= 0.4) {
    return {
      strength: i18nKey("Poor"),
      color: "orange",
      description: i18nKey("{{percentage}}% of predictions match"),
      descriptionParams: { percentage },
    };
  }
  return {
    strength: i18nKey("Very Poor"),
    color: "red",
    description: i18nKey("{{percentage}}% of predictions match"),
    descriptionParams: { percentage },
  };
}

/**
 * Interpret Mean Absolute Error (MAE)
 * Context-dependent interpretation based on scale
 *
 * @param mae - Mean Absolute Error
 * @param scale - Optional scale information {min, max} for contextual interpretation
 * @returns Interpretation with strength, color, and description
 */
export function interpretMAE(
  mae: number | null,
  scale?: { min: number; max: number },
): InterpretationResult {
  if (mae === null) {
    return {
      strength: "N/A",
      color: "gray",
      description: i18nKey("No data available"),
    };
  }

  if (scale) {
    const range = scale.max - scale.min;
    const relativeError = mae / range;

    if (relativeError <= 0.05) {
      return {
        strength: i18nKey("Excellent"),
        color: "green",
        description: i18nKey("Very low error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    if (relativeError <= 0.1) {
      return {
        strength: i18nKey("Good"),
        color: "blue",
        description: i18nKey("Low error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    if (relativeError <= 0.2) {
      return {
        strength: i18nKey("Fair"),
        color: "yellow",
        description: i18nKey("Moderate error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    if (relativeError <= 0.3) {
      return {
        strength: i18nKey("Poor"),
        color: "orange",
        description: i18nKey("High error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    return {
      strength: i18nKey("Very Poor"),
      color: "red",
      description: i18nKey("Very high error ({{percent}}% of range)"),
      descriptionParams: { percent: (relativeError * 100).toFixed(1) },
    };
  }

  // Without scale context, just report the value
  return {
    strength: "N/A",
    color: "gray",
    description: i18nKey("Average error: {{value}}"),
    descriptionParams: { value: mae.toFixed(3) },
  };
}

/**
 * Interpret Root Mean Squared Error (RMSE)
 * Context-dependent interpretation based on scale
 * RMSE penalizes large errors more than MAE
 *
 * @param rmse - Root Mean Squared Error
 * @param scale - Optional scale information {min, max} for contextual interpretation
 * @returns Interpretation with strength, color, and description
 */
export function interpretRMSE(
  rmse: number | null,
  scale?: { min: number; max: number },
): InterpretationResult {
  if (rmse === null) {
    return {
      strength: "N/A",
      color: "gray",
      description: i18nKey("No data available"),
    };
  }

  if (scale) {
    const range = scale.max - scale.min;
    const relativeError = rmse / range;

    if (relativeError <= 0.05) {
      return {
        strength: i18nKey("Excellent"),
        color: "green",
        description: i18nKey("Very low error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    if (relativeError <= 0.1) {
      return {
        strength: i18nKey("Good"),
        color: "blue",
        description: i18nKey("Low error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    if (relativeError <= 0.2) {
      return {
        strength: i18nKey("Fair"),
        color: "yellow",
        description: i18nKey("Moderate error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    if (relativeError <= 0.3) {
      return {
        strength: i18nKey("Poor"),
        color: "orange",
        description: i18nKey("High error ({{percent}}% of range)"),
        descriptionParams: { percent: (relativeError * 100).toFixed(1) },
      };
    }
    return {
      strength: i18nKey("Very Poor"),
      color: "red",
      description: i18nKey("Very high error ({{percent}}% of range)"),
      descriptionParams: { percent: (relativeError * 100).toFixed(1) },
    };
  }

  // Without scale context, just report the value
  return {
    strength: "N/A",
    color: "gray",
    description: i18nKey("Root mean squared error: {{value}}"),
    descriptionParams: { value: rmse.toFixed(3) },
  };
}
