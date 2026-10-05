import { StageAnalyzerAdapter } from "../types";
import { extractExpressionFields } from "../utils";

export const SortAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    if (val && typeof val === 'object') {
      for (const key of Object.keys(val)) {
        info.usedFields.add(key);
      }
    }
  }
};

export const LimitSkipSampleAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.altersCount = true;
  }
};

export const AddFieldsSetAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    if (val && typeof val === 'object') {
      for (const [key, v] of Object.entries(val)) {
        info.producedFields.add(key);
        if (v !== `$${key}`) {
          info.modifiedFields.add(key);
        }
        extractExpressionFields(v, info.usedFields);
      }
    }
  }
};

export const UnsetAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    const fields = Array.isArray(val) ? val : [val];
    for (const f of fields) {
      if (typeof f === 'string') {
        info.removedFields.add(f);
      }
    }
  }
};

export const UnwindAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.altersCount = true;
    let path = '';
    if (typeof val === 'string') {
      path = val;
    } else if (val && typeof val === 'object' && typeof val.path === 'string') {
      path = val.path;
    }
    if (path) {
      const cleanPath = path.startsWith('$') ? path.slice(1) : path;
      info.usedFields.add(cleanPath);
      info.producedFields.add(cleanPath);
      info.modifiedFields.add(cleanPath);
    }
    if (val && typeof val === 'object' && typeof val.includeArrayIndex === 'string') {
      info.producedFields.add(val.includeArrayIndex);
      info.modifiedFields.add(val.includeArrayIndex);
    }
  }
};

export const CountAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.altersCount = true;
    if (typeof val === 'string') {
      info.producedFields.add(val);
      info.modifiedFields.add(val);
    }
  }
};

export const SortByCountAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.altersCount = true;
    info.producedFields.add('_id');
    info.producedFields.add('count');
    info.modifiedFields.add('_id');
    info.modifiedFields.add('count');
    extractExpressionFields(val, info.usedFields);
  }
};

export const ReplaceRootAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.producedFields.add('*');
    info.modifiedFields.add('*');
    if (val && typeof val === 'object' && val.newRoot) {
      extractExpressionFields(val.newRoot, info.usedFields);
    }
  }
};

export const ReplaceWithAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.producedFields.add('*');
    info.modifiedFields.add('*');
    extractExpressionFields(val, info.usedFields);
  }
};

export const FacetAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info, getStageInfo) {
    info.isDestructive = true;
    info.altersCount = true;
    if (val && typeof val === 'object') {
      for (const [key, pipeline] of Object.entries(val)) {
        info.producedFields.add(key);
        info.modifiedFields.add(key);
        if (Array.isArray(pipeline) && getStageInfo) {
          for (const subStage of pipeline) {
            const subInfo = getStageInfo(subStage, 0);
            for (const f of subInfo.usedFields) {
              info.usedFields.add(f);
            }
          }
        }
      }
    }
  }
};

export const BucketAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.altersCount = true;
    if (val && typeof val === 'object') {
      info.producedFields.add('_id');
      info.modifiedFields.add('_id');
      if ('groupBy' in val) {
        extractExpressionFields(val.groupBy, info.usedFields);
      }
      if (val.output && typeof val.output === 'object') {
        for (const [key, expr] of Object.entries(val.output)) {
          info.producedFields.add(key);
          info.modifiedFields.add(key);
          extractExpressionFields(expr, info.usedFields);
        }
      }
    }
  }
};

export const BucketAutoAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.altersCount = true;
    if (val && typeof val === 'object') {
      info.producedFields.add('_id');
      info.modifiedFields.add('_id');
      if ('groupBy' in val) {
        extractExpressionFields(val.groupBy, info.usedFields);
      }
      if (val.output && typeof val.output === 'object') {
        for (const [key, expr] of Object.entries(val.output)) {
          info.producedFields.add(key);
          info.modifiedFields.add(key);
          extractExpressionFields(expr, info.usedFields);
        }
      }
    }
  }
};

export const SetWindowFieldsAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.altersCount = true;
    if (val && typeof val === 'object') {
      if ('partitionBy' in val) {
        extractExpressionFields(val.partitionBy, info.usedFields);
      }
      if (val.sortBy && typeof val.sortBy === 'object') {
        for (const key of Object.keys(val.sortBy)) {
          info.usedFields.add(key);
        }
      }
      if (val.output && typeof val.output === 'object') {
        for (const [key, expr] of Object.entries(val.output)) {
          info.producedFields.add(key);
          info.modifiedFields.add(key);
          extractExpressionFields(expr, info.usedFields);
        }
      }
    }
  }
};

export const DensifyAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.altersCount = true;
    if (val && typeof val === 'object') {
      if (typeof val.field === 'string') {
        info.usedFields.add(val.field);
        info.producedFields.add(val.field);
        info.modifiedFields.add(val.field);
      }
      if (Array.isArray(val.partitionByFields)) {
        for (const f of val.partitionByFields) {
          if (typeof f === 'string') {
            info.usedFields.add(f);
          }
        }
      }
      if (val.range && typeof val.range === 'object') {
        extractExpressionFields(val.range, info.usedFields);
      }
    }
  }
};

export const FillAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.altersCount = true;
    if (val && typeof val === 'object') {
      if ('partitionBy' in val) {
        extractExpressionFields(val.partitionBy, info.usedFields);
      }
      if (Array.isArray(val.partitionByFields)) {
        for (const f of val.partitionByFields) {
          if (typeof f === 'string') {
            info.usedFields.add(f);
          }
        }
      }
      if (val.sortBy && typeof val.sortBy === 'object') {
        for (const key of Object.keys(val.sortBy)) {
          info.usedFields.add(key);
        }
      }
      if (val.output && typeof val.output === 'object') {
        for (const [key, config] of Object.entries(val.output)) {
          info.producedFields.add(key);
          info.modifiedFields.add(key);
          if (config && typeof config === 'object') {
            if ('value' in config) {
              extractExpressionFields(config.value, info.usedFields);
            }
          }
        }
      }
    }
  }
};

export const DocumentsAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info) {
    info.isDestructive = true;
    info.altersCount = true;
    info.producedFields.add('*');
    info.modifiedFields.add('*');
  }
};

export const UnionWithAnalyzer: StageAnalyzerAdapter = {
  analyze(val, info, getStageInfo) {
    info.altersCount = true;
    info.producedFields.add('*');
    info.modifiedFields.add('*');
  }
};
