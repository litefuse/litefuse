import React from "react";
import { CommandItem } from "cmdk";

import { useTranslation } from "react-i18next";
type TagItemCreateProps = {
  inputValue: string;
  options: string[];
  onSelect: () => void;
};

const TagItemCreate = ({
  inputValue,
  options,
  onSelect,
}: TagItemCreateProps) => {
  const { t } = useTranslation();
  const hasNoOption = !options
    .map((value) => value.toLowerCase())
    .includes(inputValue.toLowerCase());

  const render = inputValue !== "" && hasNoOption;

  if (!render) return null;

  return (
    <CommandItem
      key={inputValue}
      value={inputValue.trim()}
      className="text-muted-foreground hover:bg-secondary/80 flex min-h-8 cursor-pointer items-center rounded-sm px-3 py-1 text-sm"
      onSelect={onSelect}
    >
      {t('Create new tag: "{{name}}"', { name: inputValue.trim() })}
    </CommandItem>
  );
};

export default TagItemCreate;
