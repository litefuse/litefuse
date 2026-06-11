// @ts-nocheck
import { useTranslation } from "react-i18next";
import { useAtom } from "jotai";
import React from "react";
import {
  searchableAtom,
  aggregatableAtom,
  fieldTypeAtom,
} from "store/discover";
import {
  AggregatableEnum,
  AGGREGATABLE,
  SearchableEnum,
  SEARCHABLE,
} from "utils/data";
import { RadioButtonGroup } from "components/ui/radio-button-group";
import { Select } from "components/ui/select";
import { css } from "@emotion/css";

export function FilterContent() {
  const { t } = useTranslation();
  const [searchable, setSearchable] = useAtom(searchableAtom);
  const [aggregatable, setAggregatable] = useAtom(aggregatableAtom);
  const [fieldType, setFieldType] = useAtom(fieldTypeAtom);
  return (
    //  className="w-auto divide-y rounded-md dark:divide-gray-700"
    <div
      className={css`
        width: auto;
        border-radius: 0.375rem;
      `}
    >
      {/* className="title dark:text-n2" */}
      <div
        className={css`
          font-size: 1.125rem;
          font-weight: 500;
        `}
      >{`Filter Fields`}</div>
      <div
        className={css`
          margin-top: 1rem;
          border: none;
        `}
      >
        <div
          className={css`
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
          `}
        >{t`Aggregatable`}</div>
        <div>
          <RadioButtonGroup
            //   name="aggregatable"
            options={AGGREGATABLE}
            value={aggregatable}
            onChange={(val) => {
              setAggregatable(val as AggregatableEnum);
            }}
          />
        </div>
      </div>
      <div
        className={css`
          margin-top: 1rem;
          border: none;
        `}
      >
        <div
          className={css`
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
          `}
        >{t`Searchable`}</div>
        <div>
          <RadioButtonGroup
            //   name="searchable"
            options={SEARCHABLE}
            value={searchable}
            onChange={(val) => {
              setSearchable(val as SearchableEnum);
            }}
          />
        </div>
      </div>
      <div
        className={css`
          margin-top: 1rem;
          border: none;
        `}
      >
        <div
          className={css`
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
          `}
        >{t`Type`}</div>
        <Select
          value={fieldType as any}
          onChange={(option) => {
            setFieldType(option.value as any);
          }}
          options={[
            {
              value: "ANY",
              label: "Any",
            },
            {
              value: "STRING",
              label: "String",
            },
            {
              value: "NUMBER",
              label: "Number",
            },
            {
              value: "DATE",
              label: "Date",
            },
          ]}
        />
      </div>
    </div>
  );
}
