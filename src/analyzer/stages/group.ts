import { StageAnalyzerAdapter } from "../types";
import { extractExpressionFields } from "../utils";

export const GroupAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.altersCount = true;
    if (val && typeof val === 'object') {
      info.producedFields.add('_id');
      info.modifiedFields.add('_id');
      if ('_id' in val) {
        extractExpressionFields(val._id, info.usedFields);
      }
      for (const [key, v] of Object.entries(val)) {
        if (key === '_id') continue;
        info.producedFields.add(key);
        info.modifiedFields.add(key);
        extractExpressionFields(v, info.usedFields);
      }
    }
  }
};
