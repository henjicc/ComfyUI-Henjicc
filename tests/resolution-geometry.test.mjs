import test from "node:test";
import assert from "node:assert/strict";
import { fitAspectRatio, snapDimensions, stageScale } from "../web/resolution-geometry.js";

test("free ratio buttons keep the limiting side instead of filling the budget", () => {
    const wide = {width:1600,height:640,grid:32};
    assert.deepEqual(fitAspectRatio(wide,1,1),{width:640,height:640});
    assert.deepEqual(fitAspectRatio(wide,4,3),{width:864,height:640});
    assert.deepEqual(fitAspectRatio({width:640,height:1600,grid:32},16,9),{width:640,height:352});
    assert.deepEqual(fitAspectRatio({width:960,height:640,grid:32},3,2),{width:960,height:640});
});

test("ratio fitting stays within the original bounds and is stable on repeated clicks", () => {
    for (const size of [{width:1600,height:640,grid:32},{width:32,height:32,grid:32},{width:640,height:1600,grid:16}]) {
        for (const [rw,rh] of [[1,1],[4,3],[3,4],[3,2],[2,3],[16,9],[9,16]]) {
            const fitted = fitAspectRatio(size,rw,rh);
            assert.ok(fitted.width <= size.width && fitted.height <= size.height);
            assert.equal(fitted.width % size.grid,0); assert.equal(fitted.height % size.grid,0);
            assert.ok(fitted.width >= size.grid && fitted.height >= size.grid);
            assert.deepEqual(fitAspectRatio({...size,...fitted},rw,rh),fitted);
        }
    }
});

const limits = { grid: 32, max_side: 4096, budget_pixels: 2_000_000 };
test("dragging snaps to the model grid and caps the budget", () => {
    for (const [w,h] of [[1001,705],[8000,8000],[-20,30],[4096,32],[32,4096]]) {
        const size = snapDimensions(w,h,limits);
        assert.equal(size.width % 32,0); assert.equal(size.height % 32,0);
        assert.ok(size.width * size.height <= limits.budget_pixels);
        assert.ok(size.width <= limits.max_side && size.height <= limits.max_side);
    }
});
test("small budgets and extreme ratios remain inside the limit", () => {
    const size = snapDimensions(4096,32,{...limits,budget_pixels:10000});
    assert.ok(size.width * size.height <= 10000);
});
test("shrinking a locked aspect shrinks the rectangle instead of magnifying it", () => {
    const large = {...limits,width:1000,height:2000};
    const small = {...limits,width:500,height:1000};
    assert.equal(stageScale(large,300,300),stageScale(small,300,300));
    const scale = stageScale(large,300,300);
    assert.equal(large.height * scale,300);
    assert.equal(small.height * scale,150);
});
