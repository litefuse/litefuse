// @ts-nocheck
import { useAtom, useAtomValue } from "jotai";
import React, { useState } from "react";
import FieldItem from "./field-item/field-item";
import { FilterContent } from "./filter-content/filter-content";
import {
  selectedFieldsAtom,
  tableFieldsAtom,
  searchableAtom,
  aggregatableAtom,
  fieldTypeAtom,
  indexesAtom,
} from "store/discover";
import {
  AggregatableEnum,
  getFieldType,
  SearchableEnum,
  FieldTypeEnum,
} from "utils/data";
import { Button } from "components/ui/button";
import { CollapsableSection } from "components/ui/collapsible-section";
import { Icon } from "components/ui/icon";
import { Input } from "components/ui/input";
import { Toggletip } from "components/ui/toggletip";

export default function DiscoverSidebar() {
  const [selectedFields, setSelectedFields] = useAtom(selectedFieldsAtom);
  const tableFields = useAtomValue(tableFieldsAtom);
  const [searchable, _setSearchable] = useAtom(searchableAtom);
  const [aggregatable, _setAggregatable] = useAtom(aggregatableAtom);
  const [fieldType, _setFieldType] = useAtom(fieldTypeAtom);
  const [searchValue, setSearchValue] = useState("");
  const indexes = useAtomValue(indexesAtom);
  const filteredFields = tableFields
    .filter((field) => {
      if (aggregatable === AggregatableEnum.ANY) {
        return true;
      }
      if (aggregatable === AggregatableEnum.YES) {
        return getFieldType(field.Type) === "NUMBER";
      }
      if (aggregatable === AggregatableEnum.NO) {
        return getFieldType(field.Type) !== "NUMBER";
      }
      return false;
    })
    .filter((field: any) => {
      if (searchable === SearchableEnum.ANY) {
        return true;
      }
      if (searchable === SearchableEnum.YES) {
        return indexes.some((index) => field.Field === index.Field);
      }
      if (searchable === SearchableEnum.NO) {
        return !indexes.some((index) => field.Field === index.Field);
      }
      return false;
    })
    .filter((field) => {
      if (fieldType === FieldTypeEnum.ANY) {
        return true;
      }
      return getFieldType(field.Type) === fieldType;
    });
  const hasSelectedFields = selectedFields.length > 0;
  const availableFields = filteredFields.filter((filed) => {
    if (selectedFields.find((item) => filed["Field"] === item["Field"])) {
      return false;
    }
    return true;
  });

  function handleAdd(field: any) {
    setSelectedFields([...selectedFields, field] as any);
  }

  function handleRemove(field: any) {
    const index = selectedFields.findIndex(
      (item: any) => item.Field === field.Field,
    );
    selectedFields.splice(index, 1);
    setSelectedFields([...selectedFields]);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 items-center gap-2 rounded-t px-2 py-1">
        <span className="text-muted-foreground inline-flex h-7 w-7 shrink-0 items-center justify-center">
          <Icon name="search" size="md" />
        </span>
        <Input
          placeholder="Search"
          className="border-none px-0 shadow-none focus-visible:ring-0"
          value={searchValue}
          onChange={(e: any) => setSearchValue(e.target.value)}
        />
        <Toggletip content={<FilterContent />}>
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <Icon name="filter" size="md" />
          </button>
        </Toggletip>
      </div>
      <div className="mt-px h-full flex-1 overflow-auto">
        <CollapsableSection
          label={
            <span className="ml-1 text-sm leading-8">Selected fields</span>
          }
          isOpen={true}
        >
          <div className="w-full">
            {hasSelectedFields ? (
              <div className="w-full">
                {selectedFields
                  .filter((field: any) => {
                    return field["Field"].includes(searchValue);
                  })
                  .map((field: any, index) => (
                    <FieldItem
                      type="remove"
                      key={index}
                      field={field}
                      onRemove={(field) => handleRemove(field)}
                    />
                  ))}
              </div>
            ) : (
              <Button
                icon="arrow"
                size="sm"
                variant="secondary"
                fill="text"
                fullWidth={true}
                className="min-h-9 w-full justify-start gap-2 pl-2 text-left"
              >
                _source
              </Button>
            )}
          </div>
        </CollapsableSection>
        <CollapsableSection
          label={
            <span className="ml-1 text-sm leading-8">Available fields</span>
          }
          isOpen={true}
        >
          <div className="w-full">
            {availableFields
              .filter((field: any) => {
                return field["Field"].includes(searchValue);
              })
              .map((field: any, index) => (
                <FieldItem
                  type="add"
                  field={field}
                  key={index}
                  onAdd={(field) => handleAdd(field)}
                />
              ))}
          </div>
        </CollapsableSection>
      </div>
    </div>
  );
}
