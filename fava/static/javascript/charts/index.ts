/**
 * This module contains the main code to render Fava's charts.
 *
 * The charts heavily use d3 libraries.
 */

import { group } from "d3-array";
import { hierarchy } from "d3-hierarchy";
import "d3-transition";
import { get } from "svelte/store";

import { getScriptTagJSON } from "../helpers";
import { favaAPI, conversion } from "../stores";
import e from "../events";
import { formatCurrency, dateFormat, currentDateFormat } from "../format";
import {
  array,
  date,
  object,
  record,
  number,
  string,
  tuple,
  unknown,
  lazy,
  Validator,
} from "../validation";

import { BaseChart } from "./base";
import {
  addInternalNodesAsLeaves,
  HierarchyContainer,
  AccountHierarchy,
  AccountHierarchyNode,
} from "./hierarchy";
import { scales } from "./helpers";

interface ScatterPlotDatum {
  date: Date;
  type: string;
  description: string;
}

interface LineChartDatum {
  name: string;
  date: Date;
  value: number;
}

type LineChartData = {
  name: string;
  values: LineChartDatum[];
};

interface BarChartDatumValue {
  name: string;
  value: number;
  budget: number;
}

interface BarChartDatum {
  label: string;
  date: Date;
  values: BarChartDatumValue[];
}

/**
 * The list of operating currencies, adding in the current conversion currency.
 */
let operatingCurrenciesWithConversion: string[] = [];
conversion.subscribe(conversionValue => {
  if (
    !conversionValue ||
    ["at_cost", "at_value", "units"].includes(conversionValue) ||
    favaAPI.options.operating_currency.includes(conversionValue)
  ) {
    operatingCurrenciesWithConversion = favaAPI.options.operating_currency;
  } else {
    operatingCurrenciesWithConversion = [
      ...favaAPI.options.operating_currency,
      conversionValue,
    ];
  }
});

e.on("page-init", () => {
  const { accounts, options } = favaAPI;
  scales.treemap.domain(accounts);
  scales.sunburst.domain(accounts);
  options.operating_currency.sort();
  options.commodities.sort();
  scales.currencies.domain([
    ...options.operating_currency,
    ...options.commodities,
  ]);
});

interface ChartWithData<T extends BaseChart> {
  data: Parameters<T["draw"]>[0];
  renderer: (svg: SVGElement) => T;
  type?: string;
}

interface BarChart {
  type: "barchart";
  data: BarChartDatum[];
  tooltipText(d: BarChartDatum): string;
}

interface LineChart {
  type: "linechart";
  data: LineChartData[];
  tooltipText(d: LineChartDatum): string;
}

interface ScatterPlot {
  type: "scatterplot";
  data: ScatterPlotDatum[];
}

type ChartTypes = HierarchyContainer;
type ChartWithDataTypes =
  | ChartWithData<ChartTypes>
  | BarChart
  | ScatterPlot
  | LineChart;

const parsers: Record<
  string,
  (json: unknown, label: string) => ChartWithDataTypes
> = {
  balances(json: unknown): LineChart {
    const parsedData = array(
      object({
        date,
        balance: record(number),
      })
    )(json);
    const allValues: LineChartDatum[] = [];
    for (const { date: date_, balance } of parsedData) {
      Object.entries(balance).forEach(([currency, value]) => {
        allValues.push({
          name: currency,
          date: date_,
          value,
        });
      });
    }
    const data = [...group(allValues, v => v.name).entries()].map(
      ([name, values]) => ({
        name,
        values,
      })
    );

    return {
      data,
      type: "linechart",
      tooltipText(d: LineChartDatum): string {
        return `${formatCurrency(d.value)} ${d.name}<em>${dateFormat.day(
          d.date
        )}</em>`;
      },
    };
  },
  commodities(json: unknown, label: string): LineChart {
    const parsedData = object({
      quote: string,
      base: string,
      prices: array(tuple([date, number])),
    })(json);
    return {
      data: [
        {
          name: label,
          values: parsedData.prices.map(d => ({
            name: label,
            date: d[0],
            value: d[1],
          })),
        },
      ],
      type: "linechart",
      tooltipText(d: LineChartDatum): string {
        return `1 ${parsedData.base} = ${formatCurrency(d.value)} ${
          parsedData.quote
        }<em>${dateFormat.day(d.date)}</em>`;
      },
    };
  },
  bar(json: unknown): BarChart {
    const jsonData = array(
      object({ date, budgets: record(number), balance: record(number) })
    )(json);
    const currentDateFmt = get(currentDateFormat);
    const data = jsonData.map(d => ({
      values: operatingCurrenciesWithConversion.map(name => ({
        name,
        value: d.balance[name] || 0,
        budget: d.budgets[name] || 0,
      })),
      date: d.date,
      label: currentDateFmt(d.date),
    }));
    function tooltipText(d: BarChartDatum): string {
      let text = "";
      d.values.forEach(a => {
        text += `${formatCurrency(a.value)} ${a.name}`;
        if (a.budget) {
          text += ` / ${formatCurrency(a.budget)} ${a.name}`;
        }
        text += "<br>";
      });
      text += `<em>${d.label}</em>`;
      return text;
    }
    return { data, tooltipText, type: "barchart" };
  },
  hierarchy(json: unknown): ChartWithData<HierarchyContainer> {
    const hierarchyValidator: Validator<AccountHierarchy> = object({
      account: string,
      balance: record(number),
      balance_children: record(number),
      children: lazy(() => array(hierarchyValidator)),
    });
    const validator = object({
      root: hierarchyValidator,
      modifier: number,
    });
    const { root, modifier } = validator(json);
    addInternalNodesAsLeaves(root);
    const data: Record<string, AccountHierarchyNode> = {};

    operatingCurrenciesWithConversion.forEach(currency => {
      const currencyHierarchy: AccountHierarchyNode = hierarchy(root)
        .sum(d => (d.balance[currency] || 0) * modifier)
        .sort((a, b) => (b.value || 0) - (a.value || 0));
      if (currencyHierarchy.value) {
        data[currency] = currencyHierarchy;
      }
    });

    return {
      data,
      renderer: (svg: SVGElement): HierarchyContainer =>
        new HierarchyContainer(svg),
    };
  },
  scatterplot(json: unknown): ScatterPlot {
    return {
      type: "scatterplot",
      data: array(
        object({
          type: string,
          date,
          description: string,
        })
      )(json),
    };
  },
};

export function parseChartData(): (ChartWithDataTypes & {
  name: string;
})[] {
  const chartData = array(
    object({
      label: string,
      type: string,
      data: unknown,
    })
  )(getScriptTagJSON("#chart-data"));
  const result: (ChartWithDataTypes & {
    name: string;
  })[] = [];
  chartData.forEach(chart => {
    const parser = parsers[chart.type];
    if (parser) {
      result.push({
        name: chart.label,
        ...parser(chart.data, chart.label),
      });
    }
  });
  return result;
}

export function parseQueryChart(data: unknown): ChartWithDataTypes | undefined {
  if (!Array.isArray(data) || !data.length) {
    return undefined;
  }
  if (data[0].group !== undefined) {
    const validated = array(object({ group: string, balance: record(number) }))(
      data
    );
    const root: AccountHierarchy = {
      account: "(root)",
      balance: {},
      children: [],
    };
    const accountMap: Map<string, AccountHierarchy> = new Map([
      [root.account, root],
    ]);
    const addNode = (node: AccountHierarchy): void => {
      const name = node.account;
      const existing = accountMap.get(name);
      if (existing) {
        existing.balance = node.balance;
        return;
      }
      accountMap.set(name, node);
      const parentEnd = name.lastIndexOf(":");
      const parentId = parentEnd > 0 ? name.slice(0, parentEnd) : root.account;
      let parent = accountMap.get(parentId);
      if (!parent) {
        parent = { account: parentId, balance: {}, children: [] };
        addNode(parent);
      }
      parent.children.push(node);
    };
    for (const { group: account = "(empty)", balance } of validated) {
      addNode({ account, balance, children: [] });
    }

    const chartData: Record<string, AccountHierarchyNode> = {};
    operatingCurrenciesWithConversion.forEach(currency => {
      const currencyHierarchy: AccountHierarchyNode = hierarchy(root)
        .sum(d => d.balance[currency] || 0)
        .sort((a, b) => (b.value || 0) - (a.value || 0));
      if (currencyHierarchy.value !== undefined) {
        chartData[currency] = currencyHierarchy;
      }
    });

    return {
      data: chartData,
      renderer: (svg: SVGElement): HierarchyContainer =>
        new HierarchyContainer(svg),
    };
  }
  if (data[0].date !== undefined) {
    return parsers.balances(data, "");
  }
  return undefined;
}
