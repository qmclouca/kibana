/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Filter } from '@kbn/es-query';
import { SavedObjectReference } from 'kibana/public';
import { PersistableFilter } from '../../common';

export function extractFilterReferences(
  filters: Filter[]
): { persistableFilters: PersistableFilter[]; references: SavedObjectReference[] } {
  const references: SavedObjectReference[] = [];
  const persistableFilters = filters.map((filterRow, i) => {
    if (!filterRow.meta || !filterRow.meta.index) {
      return filterRow;
    }
    const refName = `filter-index-pattern-${i}`;
    references.push({
      name: refName,
      type: 'index-pattern',
      id: filterRow.meta.index,
    });
    const newFilter = {
      ...filterRow,
      meta: {
        ...filterRow.meta,
        indexRefName: refName,
      },
    };
    // remove index because it's specified by indexRefName
    delete newFilter.meta.index;
    // remove value because it can't be persisted
    delete newFilter.meta.value;
    return newFilter;
  });

  return { persistableFilters, references };
}

export function injectFilterReferences(
  filters: PersistableFilter[],
  references: SavedObjectReference[]
) {
  return filters.map((filterRow) => {
    if (!filterRow.meta || !filterRow.meta.indexRefName) {
      return filterRow as Filter;
    }
    const { indexRefName, ...metaRest } = filterRow.meta;
    const reference = references.find((ref) => ref.name === indexRefName);
    if (!reference) {
      throw new Error(`Could not find reference for ${indexRefName}`);
    }
    return {
      ...filterRow,
      meta: { ...metaRest, index: reference.id },
    };
  });
}
