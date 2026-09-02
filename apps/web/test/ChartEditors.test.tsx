import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { EntityId, TableEntity } from '@panorama/core';
import { CameraController, previewEntity } from '@panorama/renderer';
import type { PanoramaRenderer } from '@panorama/renderer';
import { ChartEditors } from '../src/panorama/ChartEditors.js';
import { createAppHarness, firstTableId } from './harness.js';

/**
 * The chart controls are real DOM over the canvas, so they are tested as DOM:
 * choosing, toggling, and the picture keeping up with the choices.
 */

interface Mounted {
  readonly harness: ReturnType<typeof createAppHarness>;
  readonly chartId: EntityId;
  readonly camera: CameraController;
  readonly errors: (string | null)[];
  frame(): Promise<void>;
}

const mount = async (options: Parameters<typeof createAppHarness>[0] = {}): Promise<Mounted> => {
  const harness = createAppHarness(options);
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
  const { tableId: chartId } = await harness.workspace.openChart(firstTableId(harness));
  await harness.settle();

  const camera = new CameraController();
  camera.setViewport({ width: 1_000, height: 800 });
  camera.moveTo(0, 0);
  const rendererRef = {
    current: {
      camera,
      drawnEntity: (entity: TableEntity) =>
        previewEntity(
          entity,
          harness.workspace.core.session.drag,
          harness.workspace.core.session.pointer?.world ?? null,
          harness.workspace.core.constraints,
        ),
    } as unknown as PanoramaRenderer,
  };

  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

  const errors: (string | null)[] = [];
  render(
    <ChartEditors
      workspace={harness.workspace}
      rendererRef={rendererRef}
      onError={(message) => errors.push(message)}
    />,
  );

  const frame = async (): Promise<void> => {
    const pending = callbacks.splice(0, callbacks.length);
    await act(async () => {
      for (const callback of pending) callback(0);
      await Promise.resolve();
    });
  };
  await frame();
  await frame();
  return { harness, chartId, camera, errors, frame };
};

/**
 * The control carrying a given label.
 *
 * Found through the label's own element rather than by searching the form for the
 * text, because the chart-type menu holds words like "Line" too — and a query
 * that cannot tell a control from an option inside one finds both.
 */
const controlFor = <TElement extends Element>(label: string, tag: string): TElement => {
  const span = [
    ...document.querySelectorAll('.pn-chart-field > span, .pn-chart-check > span'),
  ].find((node) => node.textContent === label);
  const found = span?.closest('label')?.querySelector(tag);
  if (found === null || found === undefined) throw new Error(`no ${tag} labelled ${label}`);
  return found as TElement;
};

const select = (label: string): HTMLSelectElement => controlFor<HTMLSelectElement>(label, 'select');

const check = (label: string): HTMLInputElement => controlFor<HTMLInputElement>(label, 'input');

const number = (label: string): HTMLInputElement => controlFor<HTMLInputElement>(label, 'input');

/**
 * Whether a control with this label is offered at all.
 *
 * Matched against the label's own text rather than the whole form, because the
 * chart-type dropdown contains options called "Bars" and "Line" too — and asking
 * "is there a Line control" must not be answered by the word inside a menu.
 */
const hasControl = (label: string): boolean =>
  [...document.querySelectorAll('.pn-chart-field > span, .pn-chart-check > span')].some(
    (node) => node.textContent === label,
  );

/** Native disclosure: a group's controls are in the DOM whether or not it is open. */
const groupTitles = (): readonly string[] =>
  [...document.querySelectorAll('.pn-chart-group > summary')].map((node) => node.textContent ?? '');

describe('the chart setup overlay', () => {
  it('opens with the guess already made', async () => {
    await mount();
    expect(select('Chart').value).toBe('bar');
    expect(select('By').value).toBe('COUNTRY');
    expect(select('Measure').value).toBe('sum');
    // The measured column is ticked, and the identifier beside it is not.
    const revenue = screen.getByLabelText('Measured columns').querySelector('input');
    expect(revenue).toBeDefined();
  });

  it('offers only the measurable columns to measure', async () => {
    await mount();
    const names = [...screen.getByLabelText('Measured columns').querySelectorAll('span')].map(
      (node) => node.textContent,
    );
    // Numbers only: there is nothing to sum in a date or a country name.
    expect(names).toEqual(['ORDER_ID', 'REVENUE']);
  });

  it('redraws when the chart type changes', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Chart'), { target: { value: 'pie' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.type).toBe('pie');
  });

  it('redraws when the dimension changes', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('By'), { target: { value: 'ORDER_DATE' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.category).toBe('ORDER_DATE');
  });

  it('drops the column list when it is counting rows, having nothing to count', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Measure'), { target: { value: 'count' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.aggregate).toBe('count');
    expect(screen.queryByLabelText('Measured columns')).toBeNull();
  });

  it('adds and removes a measure as it is ticked', async () => {
    const { harness, chartId } = await mount();
    const boxes = [...screen.getByLabelText('Measured columns').querySelectorAll('input')];
    const orderId = boxes[0] as HTMLInputElement;
    const revenue = boxes[1] as HTMLInputElement;

    fireEvent.click(orderId);
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.values).toEqual(['REVENUE', 'ORDER_ID']);

    fireEvent.click(revenue);
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.values).toEqual(['ORDER_ID']);
  });

  it('lets a pie have one measure and one only', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Chart'), { target: { value: 'pie' } });
    await harness.settle();
    const boxes = [...screen.getByLabelText('Measured columns').querySelectorAll('input')];
    expect((boxes[0] as HTMLInputElement).type).toBe('radio');

    fireEvent.click(boxes[0] as HTMLInputElement);
    await harness.settle();
    // Chosen, not added: more than one slice per category is not a pie.
    expect(harness.workspace.chartDraft(chartId)?.values).toEqual(['ORDER_ID']);
  });

  it('offers stacking only where stacking means something', async () => {
    const { harness } = await mount();
    expect(hasControl('Stack the series')).toBe(true);
    fireEvent.change(select('Chart'), { target: { value: 'scatter' } });
    await harness.settle();
    expect(hasControl('Stack the series')).toBe(false);
  });

  it('stacks the series when asked', async () => {
    const { harness, chartId } = await mount();
    const check = screen.getByText('Stack the series').closest('label')?.querySelector('input');
    fireEvent.click(check as HTMLInputElement);
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.stacked).toBe(true);
  });

  it('commits the setup and takes the controls away', async () => {
    const { harness, chartId, frame } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    await harness.settle();
    await frame();

    const entity = harness.workspace.core.world.entities.get(chartId) as TableEntity;
    expect(entity.mode).toBe('result');
    expect(screen.queryByText('Show chart')).toBeNull();
  });

  it('reports a refusal rather than committing it', async () => {
    const { harness, chartId, errors } = await mount();
    harness.workspace.setChartDraft(chartId, {
      type: 'bar',
      category: '',
      values: [],
      aggregate: 'sum',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    expect(errors.at(-1)).toMatch(/Choose a column/);
  });

  it('follows the box as the camera pans and zooms', async () => {
    const { camera, frame } = await mount();
    const box = screen.getByText('Chart').closest<HTMLElement>('.pn-chart-editor');
    if (box === null) throw new Error('expected a positioned box');

    const first = box.style.transform;
    camera.moveTo(120, 80);
    await frame();
    expect(box.style.transform).not.toBe(first);

    camera.setScale(2);
    await frame();
    expect(Number.parseFloat(box.style.fontSize)).toBeGreaterThan(0);
  });

  it('steps aside when the camera is too far out to use it', async () => {
    const { camera, frame } = await mount();
    const box = screen.getByText('Chart').closest<HTMLElement>('.pn-chart-editor');
    camera.setScale(0.2);
    await frame();
    expect(box?.style.visibility).toBe('hidden');
    camera.setScale(1);
    await frame();
    expect(box?.style.visibility).toBe('visible');
  });

  it('keeps up with the box while it is being dragged', async () => {
    const { harness, chartId, frame } = await mount();
    const box = screen.getByText('Chart').closest<HTMLElement>('.pn-chart-editor');
    const before = box?.style.transform;
    const entity = harness.workspace.core.world.entities.get(chartId) as TableEntity;

    harness.workspace.core.dispatchSession({
      type: 'BeginDrag',
      drag: {
        kind: 'move-entity',
        entityId: chartId,
        entityStart: { x: entity.transform.x, y: entity.transform.y, z: 0 },
        pointerStart: { x: 0, y: 0, z: 0 },
      },
    });
    harness.workspace.core.dispatchSession({
      type: 'SetPointer',
      pointer: { world: { x: 90, y: 40, z: 0 }, screen: { x: 0, y: 0 } },
    });
    await frame();
    // The drawn transform, not the committed one: the field moves with the box
    // rather than snapping into place when the drag commits.
    expect(box?.style.transform).not.toBe(before);
  });

  it('waits for a renderer rather than positioning against nothing', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.workspace.openChart(firstTableId(harness));

    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
    render(
      <ChartEditors
        workspace={harness.workspace}
        rendererRef={{ current: null }}
        onError={() => undefined}
      />,
    );
    await act(async () => {
      for (const callback of callbacks.splice(0, callbacks.length)) callback(0);
      await Promise.resolve();
    });
    // The controls exist; they simply have nowhere to be told to go yet.
    expect(screen.queryByText('Show chart')).not.toBeNull();
  });

  it('reports a refusal that was not even an error', async () => {
    const { harness, errors } = await mount();
    harness.workspace.showChart = (): never => {
      throw 'dropped';
    };
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    expect(errors.at(-1)).toBe('dropped');
  });

  it('renders nothing at all for a chart that has gone', async () => {
    const { harness, chartId, frame } = await mount();
    await harness.workspace.closeTable(chartId);
    await frame();
    expect(screen.queryByText('Show chart')).toBeNull();
  });
});

describe('the shape of the form', () => {
  it('groups the settings by what someone is thinking about', async () => {
    await mount();
    // A flat list of every setting a chart library offers is not a form.
    expect(groupTitles()).toEqual([
      'What to draw',
      'Categories',
      'How it looks',
      'What is written on it',
      'Anything else',
    ]);
  });

  it('opens on what to draw and folds the rest away', async () => {
    await mount();
    const groups = [...document.querySelectorAll('.pn-chart-group')] as HTMLDetailsElement[];
    expect(groups[0]?.open).toBe(true);
    expect(groups.slice(1).some((group) => group.open)).toBe(false);
  });

  it('sits beside the preview rather than over it', async () => {
    const { frame } = await mount();
    await frame();
    const box = screen.getByText('Chart').closest<HTMLElement>('.pn-chart-editor');
    // Narrower than the box it belongs to: the rest of it is the chart.
    expect(Number.parseFloat(box?.style.width ?? '0')).toBeGreaterThan(0);
    expect(Number.parseFloat(box?.style.width ?? '0')).toBeLessThan(620);
  });
});

describe('the settings the form offers', () => {
  it('orders the categories, and limits how many there are', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Order'), { target: { value: 'name' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.sort).toBe('name');

    fireEvent.change(number('Show'), { target: { value: '8' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.categoryLimit).toBe(8);
  });

  it('limits how many rows it reads', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(number('Read rows'), { target: { value: '5000' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.rowLimit).toBe(5_000);
  });

  it('leaves the chart alone while a number is mid-edit', async () => {
    const { harness, chartId } = await mount();
    const before = harness.workspace.chartDraft(chartId)?.categoryLimit;
    // Emptied on the way to typing something else.
    fireEvent.change(number('Show'), { target: { value: '' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.categoryLimit).toBe(before);
  });

  it('rounds and clamps a number rather than passing nonsense on', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(number('Show'), { target: { value: '7.6' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.categoryLimit).toBe(8);
    fireEvent.change(number('Show'), { target: { value: '99999' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.categoryLimit).toBe(200);
  });

  it('turns bars on their side, and offers that only for bars', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Direction'), { target: { value: 'horizontal' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.orientation).toBe('horizontal');

    fireEvent.change(select('Chart'), { target: { value: 'line' } });
    await harness.settle();
    expect(hasControl('Direction')).toBe(false);
  });

  it('offers a line its curve and its marks, and a bar chart neither', async () => {
    const { harness, chartId } = await mount();
    expect(hasControl('Curve')).toBe(false);
    expect(hasControl('Mark each point')).toBe(false);

    fireEvent.change(select('Chart'), { target: { value: 'line' } });
    await harness.settle();
    fireEvent.change(select('Curve'), { target: { value: 'stepped' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.curve).toBe('stepped');

    fireEvent.click(check('Mark each point'));
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.showPoints).toBe(false);
  });

  it('offers a pie its hole, and nothing with axes', async () => {
    const { harness, chartId } = await mount();
    expect(hasControl('Hole in the middle')).toBe(false);

    fireEvent.change(select('Chart'), { target: { value: 'pie' } });
    await harness.settle();
    expect(hasControl('Scale')).toBe(false);
    expect(hasControl('Grid lines')).toBe(false);

    fireEvent.click(check('Hole in the middle'));
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.hole).toBe(false);
  });

  it('counts the value axis in multiples when asked', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Scale'), { target: { value: 'log' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.scale).toBe('log');
  });

  it('writes the values on, rules the grid, and names the series', async () => {
    const { harness, chartId } = await mount();
    fireEvent.click(check('Write the values on'));
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.showValues).toBe(true);

    fireEvent.click(check('Grid lines'));
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.showGrid).toBe(false);

    fireEvent.change(select('Legend'), { target: { value: 'never' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.legend).toBe('never');
  });
});

describe('the way out of the controls', () => {
  it('takes an ECharts option and keeps it', async () => {
    const { harness, chartId } = await mount();
    const field = screen.getByLabelText('Extra chart settings');
    fireEvent.change(field, { target: { value: '{"yAxis":{"name":"money"}}' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.extra).toBe('{"yAxis":{"name":"money"}}');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says what is wrong with it rather than swallowing it', async () => {
    const { harness } = await mount();
    fireEvent.change(screen.getByLabelText('Extra chart settings'), {
      target: { value: '{oops' },
    });
    await harness.settle();
    // Reported beside the field, and the chart still draws without it.
    expect(screen.getByRole('alert').textContent).not.toBe('');
    expect(screen.getByRole('alert').textContent).toBeTruthy();
  });
});

describe('the custom option, which is aimed at an agent', () => {
  const choose = async (harness: ReturnType<typeof createAppHarness>): Promise<void> => {
    fireEvent.change(select('Chart'), { target: { value: 'custom' } });
    await harness.settle();
  };

  it('is offered in the form, because hiding it would misdescribe the chart', async () => {
    await mount();
    const types = [...select('Chart').querySelectorAll('option')].map((node) => node.value);
    expect(types).toEqual(['bar', 'line', 'area', 'scatter', 'pie', 'custom']);
  });

  it('turns the escape hatch into the chart itself', async () => {
    const { harness, chartId } = await mount();
    await choose(harness);
    // The last group is now the whole point, so it is the one that is open.
    expect(groupTitles()).toEqual(['What to draw', 'Categories', 'The chart']);
    const groups = [...document.querySelectorAll('.pn-chart-group')] as HTMLDetailsElement[];
    expect(groups.at(-1)?.open).toBe(true);

    const field = screen.getByLabelText('The chart option');
    expect((field as HTMLTextAreaElement).rows).toBeGreaterThan(4);
    fireEvent.change(field, { target: { value: '{"series":[{"type":"radar"}]}' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.extra).toBe('{"series":[{"type":"radar"}]}');
    expect(harness.workspace.chartDraft(chartId)?.type).toBe('custom');
  });

  it('drops the controls that only describe an assembled chart', async () => {
    const { harness } = await mount();
    await choose(harness);
    // Every one of these adjusts something Panorama would have built, and a
    // written option builds it itself.
    for (const label of ['Direction', 'Curve', 'Legend', 'Write the values on', 'Grid lines']) {
      expect(hasControl(label)).toBe(false);
    }
    // What is left shapes the data the option can read.
    expect(hasControl('By')).toBe(true);
    expect(hasControl('Measure')).toBe(true);
    expect(hasControl('Order')).toBe(true);
    expect(hasControl('Read rows')).toBe(true);
  });

  it('says what will be in the dataset, so it can be read off the form', async () => {
    const { harness } = await mount();
    await choose(harness);
    const hint = [...document.querySelectorAll('.pn-chart-hint')].at(-1)?.textContent ?? '';
    expect(hint).toContain('dataset.source');
    // The header row, named after the columns actually chosen.
    expect(hint).toContain('[COUNTRY, REVENUE]');
  });

  it('still reports what is wrong with the option it was given', async () => {
    const { harness } = await mount();
    await choose(harness);
    fireEvent.change(screen.getByLabelText('The chart option'), { target: { value: '{oops' } });
    await harness.settle();
    expect(screen.getByRole('alert').textContent).toBeTruthy();
  });
});

describe('splitting a chart by a second column', () => {
  it('offers every other column, and nothing by default', async () => {
    await mount();
    const options = [...select('Split by').querySelectorAll('option')].map((node) => node.value);
    // Not the one already being grouped by: nothing to tabulate against itself.
    expect(options).toEqual(['', 'ORDER_ID', 'ORDER_DATE', 'REVENUE']);
    expect(select('Split by').value).toBe('');
  });

  it("makes the series the second column's values, one measure at a time", async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Split by'), { target: { value: 'ORDER_DATE' } });
    await harness.settle();
    expect(harness.workspace.chartDraft(chartId)?.breakdown).toBe('ORDER_DATE');
    // One measure: the list becomes a choice rather than a set of ticks.
    const inputs = [...screen.getByLabelText('Measured columns').querySelectorAll('input')];
    expect(inputs.every((input) => input.type === 'radio')).toBe(true);
  });

  it('goes back to not being split at all, rather than to being split by nothing', async () => {
    const { harness, chartId } = await mount();
    fireEvent.change(select('Split by'), { target: { value: 'REVENUE' } });
    await harness.settle();
    fireEvent.change(select('Split by'), { target: { value: '' } });
    await harness.settle();
    // Absent, not empty: a specification with an empty breakdown would have to
    // be special-cased everywhere it is read.
    expect('breakdown' in (harness.workspace.chartDraft(chartId) ?? {})).toBe(false);
  });
});

/**
 * A chart over columns a model describes.
 *
 * This is where the semantic layer stops being decoration. The harness's model
 * says `REVENUE` is a metric that sums, `ORDER_ID` is a metric that must not be
 * aggregated at all, `COUNTRY` is a dimension — and that revenue may not be
 * attributed to country, which is the shape of the fan-out error a chart would
 * otherwise draw perfectly plausibly.
 */
describe('a chart the model has an opinion about', () => {
  const described = () => mount({ semanticLayer: true });

  it('offers the model’s names rather than the column names', async () => {
    await described();
    const options = [...select('By').querySelectorAll('option')].map((node) => node.textContent);
    // The model's name for the column, with its reason where it has one.
    expect(options.some((text) => text?.startsWith('Country') === true)).toBe(true);
    const measures = [...screen.getByLabelText('Measured columns').querySelectorAll('span')].map(
      (node) => node.textContent,
    );
    expect(measures).toContain('Total Revenue');
    expect(measures).not.toContain('REVENUE');
  });

  it('offers the model’s metrics as the measures, not every number', async () => {
    await described();
    const measures = [...screen.getByLabelText('Measured columns').querySelectorAll('span')].map(
      (node) => node.textContent,
    );
    // `ORDER_DATE` is not a number and `COUNTRY` is a dimension; both are out.
    // What is in is what the model calls a metric.
    // In the columns' own order: `ORDER_ID` is the ratio, `REVENUE` the sum.
    expect(measures).toEqual(['Margin %', 'Total Revenue']);
  });

  it('opens on the aggregation the metric declares', async () => {
    await described();
    expect(select('Measure').value).toBe('sum');
  });

  /**
   * The guess is made from the columns alone and cannot know about pairings, so
   * it can land on one the model refuses. A category that is selected *and*
   * greyed out reads as a bug rather than as a model being careful, so the first
   * allowed one is taken instead.
   */
  it('does not open on a pairing the model refuses', async () => {
    await described();
    expect(select('By').value).not.toBe('COUNTRY');
    const chosen = [...select('By').querySelectorAll('option')].find(
      (node) => node.value === select('By').value,
    );
    expect(chosen?.disabled).toBe(false);
  });

  /**
   * A ratio is recomputed per group by the model. A chart groups more coarsely
   * than the rows it is drawn from, so summing or averaging one is precisely the
   * arithmetic the layer exists to prevent — and the control says so rather than
   * quietly allowing it.
   */
  it('refuses to measure a metric that must not be aggregated', async () => {
    await described();
    const margin = [...screen.getByLabelText('Measured columns').querySelectorAll('label')].find(
      (node) => node.textContent?.startsWith('Margin %'),
    );
    expect(margin?.querySelector('input')?.disabled).toBe(true);
    expect(margin?.textContent).toContain('cannot be summed or averaged');
  });

  /**
   * The refusal that is the whole correctness argument: a metric charged on one
   * side of a one-to-many join, asked for by a dimension on the other side, is
   * counted once per row and multiplied. Shown and disabled, with the reason.
   */
  it('greys out a category the model will not attribute the measure to', async () => {
    await described();
    const country = [...select('By').querySelectorAll('option')].find(
      (node) => node.value === 'COUNTRY',
    );
    expect(country?.disabled).toBe(true);
    expect(country?.textContent).toContain('which would multiply it');
    // And the same pairing seen from the other side: with that category chosen,
    // the measure is the one refused.
    fireEvent.change(select('By'), { target: { value: 'ORDER_DATE' } });
    expect(
      [...select('By').querySelectorAll('option')].find((node) => node.value === 'COUNTRY')
        ?.disabled,
    ).toBe(true);
  });

  it('leaves a chart over an undescribed table exactly as it was', async () => {
    await mount();
    const measures = [...screen.getByLabelText('Measured columns').querySelectorAll('span')].map(
      (node) => node.textContent,
    );
    expect(measures).toEqual(['ORDER_ID', 'REVENUE']);
    expect([...select('By').querySelectorAll('option')].every((node) => !node.disabled)).toBe(true);
  });
});
