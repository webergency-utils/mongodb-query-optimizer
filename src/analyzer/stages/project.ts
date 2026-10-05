import { StageAnalyzerAdapter } from "../types";
import { extractExpressionFields } from "../utils";

export const ProjectAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    if (val && typeof val === 'object') {
      let hasInclusions = false;
      for (const [key, v] of Object.entries(val)) {
        if (key === '_id') continue;
        if (v === 1 || v === true || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0)) {
          hasInclusions = true;
        } else if (typeof v === 'string' && v.startsWith('$')) {
          hasInclusions = true;
        }
      }
      if (!hasInclusions) {
        info.isDestructive = false;
      }

      for (const [key, v] of Object.entries(val)) {
        if (v === 0 || v === false) {
          info.removedFields.add(key);
        } else {
          info.producedFields.add(key);
          if (v !== 1 && v !== true && v !== `$${key}`) {
            info.modifiedFields.add(key);
          }
          if (v === 1 || v === true) {
            info.usedFields.add(key);
          } else {
            extractExpressionFields(v, info.usedFields);
          }
        }
      }
    }
  }
};
