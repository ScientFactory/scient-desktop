import type { ComputeToolkitId } from "@scientfactory/compute";

import {
  PYTHON_BIOINFORMATICS_TOOLKIT,
  PYTHON_IMAGE_ANALYSIS_TOOLKIT,
  PYTHON_LARGE_DATA_TOOLKIT,
} from "./PythonToolkitCatalog.ts";

// Bounded, offline file exercises run before activation. Keep the source embedded
// so the packaged backend verifies exactly the same workflows as source builds.
const FILE_CHECKS = String.raw`
from pathlib import Path
from tempfile import TemporaryDirectory

def check_everyday_files(root):
    import json
    import pandas as pd
    import requests
    import yaml
    from PIL import Image
    from defusedxml.ElementTree import fromstring
    from defusedxml.common import DefusedXmlException
    from openpyxl.xml import DEFUSEDXML
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

    config = {"title": "Scientific data Δ", "values": [1, 2, 3], "enabled": True}
    yaml_path = root / "settings.yaml"
    yaml_path.write_text(yaml.safe_dump(config, allow_unicode=True), encoding="utf-8")
    assert yaml.safe_load(yaml_path.read_text(encoding="utf-8")) == config
    try:
        yaml.safe_load("!!python/object/apply:builtins.str [1]")
    except yaml.constructor.ConstructorError:
        pass
    else:
        raise AssertionError("YAML object construction was not rejected")

    assert DEFUSEDXML, "openpyxl XML hardening is unavailable"
    try:
        fromstring('<!DOCTYPE x [<!ENTITY value "expanded">]><x>&value;</x>')
    except DefusedXmlException:
        pass
    else:
        raise AssertionError("XML entities were not rejected")

    frame = pd.DataFrame({"name": ["alpha", "βeta"], "value": [1.5, 2.5]})
    for suffix in ("csv", "xlsx"):
        path = root / ("table." + suffix)
        if suffix == "csv":
            frame.to_csv(path, index=False)
            restored = pd.read_csv(path)
        else:
            frame.to_excel(path, index=False, engine="openpyxl")
            restored = pd.read_excel(path, engine="openpyxl")
        pd.testing.assert_frame_equal(frame, restored)
    assert "alpha" in frame.to_markdown(index=False)
    assert "<table" in frame.style.to_html()
    styled = root / "styled.xlsx"
    frame.style.to_excel(styled, index=False, engine="openpyxl")
    pd.testing.assert_frame_equal(frame, pd.read_excel(styled, engine="openpyxl"))

    image_path = root / "image.png"
    with Image.new("RGB", (16, 12), color=(25, 50, 75)) as original:
        original.save(image_path)
    with Image.open(image_path) as original:
        assert original.size == (16, 12)
        with original.crop((0, 0, 8, 8)) as cropped:
            with cropped.resize((4, 4)) as resized:
                resized.save(root / "image.jpg")
    with Image.open(root / "image.jpg") as restored:
        assert restored.size == (4, 4)

    # Generate a tiny text PDF without adding a report-generation dependency.
    with PdfWriter() as writer:
        page = writer.add_blank_page(width=200, height=200)
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({
                NameObject("/F1"): DictionaryObject({
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                })
            })
        })
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 10 100 Td (Scient PDF fixture) Tj ET")
        page[NameObject("/Contents")] = stream
        writer.add_metadata({"/Title": "Scient fixture"})
        writer.write(root / "input.pdf")
    with PdfReader(root / "input.pdf") as reader:
        assert "Scient PDF fixture" in reader.pages[0].extract_text()
        assert reader.metadata.title == "Scient fixture"
        with PdfWriter() as writer:
            writer.add_page(reader.pages[0])
            writer.add_page(reader.pages[0])
            writer.write(root / "merged.pdf")
    with PdfReader(root / "merged.pdf") as reader:
        assert len(reader.pages) == 2
        with PdfWriter() as writer:
            writer.add_page(reader.pages[1])
            writer.write(root / "split.pdf")
    with PdfReader(root / "split.pdf") as reader:
        assert len(reader.pages) == 1
        assert "Scient PDF fixture" in reader.pages[0].extract_text()

    # Exercise the HTTP client offline; real loopback transport is tested in CI.
    with requests.Session() as session:
        session.trust_env = False
        request = session.prepare_request(requests.Request(
            "POST", "https://example.invalid/data", json=config
        ))
        assert json.loads(request.body) == config
        assert request.headers["Content-Type"] == "application/json"

def check_large_data(root):
    import cftime
    import dask.array as da
    import dask.dataframe as dd
    import h5py
    import numpy as np
    import pandas as pd
    import xarray as xr
    import zarr

    frame = pd.DataFrame({"label": ["a", "b", "c"], "value": [1, 2, 3]})
    for suffix in ("parquet", "feather"):
        path = root / ("columnar." + suffix)
        if suffix == "parquet":
            frame.to_parquet(path, engine="pyarrow", index=False)
            restored = pd.read_parquet(path, engine="pyarrow")
        else:
            frame.to_feather(path)
            restored = pd.read_feather(path)
        pd.testing.assert_frame_equal(frame, restored)
    assert dd.from_pandas(frame, npartitions=2).value.sum().compute(scheduler="synchronous") == 6
    assert int(da.arange(6, chunks=3).sum().compute(scheduler="synchronous")) == 15

    values = np.arange(12, dtype=np.int16).reshape(3, 4)
    with h5py.File(root / "data.h5", "w") as handle:
        handle.create_dataset("values", data=values, compression="gzip")
    with h5py.File(root / "data.h5", "r") as handle:
        np.testing.assert_array_equal(handle["values"][:], values)

    dates = [cftime.Datetime360Day(2000, 2, 29), cftime.Datetime360Day(2000, 2, 30)]
    dataset = xr.Dataset({"temperature": ("time", [10., 12.])}, coords={"time": dates})
    dataset.to_netcdf(root / "calendar.nc", engine="h5netcdf")
    with xr.open_dataset(root / "calendar.nc", engine="h5netcdf") as restored:
        xr.testing.assert_equal(restored, dataset)
        assert restored.time.values[1].day == 30
    dataset.close()
    for version in (2, 3):
        store = root / ("array-v%d.zarr" % version)
        array = zarr.open_array(store, mode="w", shape=values.shape,
                               chunks=(1, 4), dtype="int16", zarr_format=version)
        array[:] = values
        np.testing.assert_array_equal(zarr.open_array(store, mode="r")[:], values)

def check_images(root):
    import imageio.v3 as iio
    import numpy as np
    import tifffile
    from skimage import filters, measure

    pixels = np.arange(64, dtype=np.uint16).reshape(8, 8)
    for compression in ("lzw", "deflate"):
        path = root / (compression + ".tif")
        tifffile.imwrite(path, pixels, compression=compression)
        np.testing.assert_array_equal(tifffile.imread(path), pixels)
    stack = np.stack([pixels, pixels + 1])
    tifffile.imwrite(root / "stack.ome.tif", stack, metadata={"axes": "ZYX"},
                     photometric="minisblack", compression="lzw")
    np.testing.assert_array_equal(tifffile.imread(root / "stack.ome.tif"), stack)
    iio.imwrite(root / "array.png", pixels.astype(np.uint8))
    np.testing.assert_array_equal(iio.imread(root / "array.png"), pixels.astype(np.uint8))
    assert filters.sobel(pixels).shape == pixels.shape
    mask = np.zeros((8, 8), dtype=bool)
    mask[2:4, 2:4] = True
    assert measure.regionprops(measure.label(mask))[0].area == 4

def check_sequences(root):
    from Bio import SeqIO
    from pyfaidx import Fasta

    fasta = root / "sequence.fasta"
    fasta.write_text(">sample\nATGCGTAC\n", encoding="ascii")
    records = list(SeqIO.parse(fasta, "fasta"))
    assert str(records[0].seq.reverse_complement()) == "GTACGCAT"
    with Fasta(str(fasta)) as indexed:
        assert str(indexed["sample"][2:6]) == "GCGT"
    fastq = root / "sequence.fastq"
    fastq.write_text("@sample\nATGC\n+\nIIII\n", encoding="ascii")
    records = list(SeqIO.parse(fastq, "fastq"))
    assert records[0].letter_annotations["phred_quality"] == [40] * 4
`;

export function managedPythonFileCheck(toolkitIds: ReadonlyArray<ComputeToolkitId>): string {
  const checks = ["check_everyday_files(root)"];
  if (toolkitIds.includes(PYTHON_LARGE_DATA_TOOLKIT.toolkitId))
    checks.push("check_large_data(root)");
  if (toolkitIds.includes(PYTHON_IMAGE_ANALYSIS_TOOLKIT.toolkitId))
    checks.push("check_images(root)");
  if (toolkitIds.includes(PYTHON_BIOINFORMATICS_TOOLKIT.toolkitId))
    checks.push("check_sequences(root)");
  return `${FILE_CHECKS}\nwith TemporaryDirectory(prefix="scient-python-check-") as directory:\n    root = Path(directory)\n    ${checks.join("\n    ")}`;
}
